// index.js (Vercel-ready)
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const streamifier = require("streamifier");
const admin = require("firebase-admin");

// Models and middleware (make sure these files exist)
const User = require("./models/User");
const Post = require("./models/Post");
const Like = require("./models/Like");
const Comment = require("./models/Comment");
const verifyToken = require("./middleware/auth");

// Parse Firebase key (ensure FIREBASE_ADMIN_KEY exists and is valid JSON)
let serviceAccount = null;
try {
  if (process.env.FIREBASE_ADMIN_KEY) {
    serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);
  }
} catch (e) {
  console.error("Invalid FIREBASE_ADMIN_KEY JSON:", e);
}

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_KEY,
  api_secret: process.env.CLOUD_SECRET,
});

// Multer (memory) - safe for serverless
const upload = multer({ storage: multer.memoryStorage() });

// Helper: initialize Firebase Admin once
function initFirebase() {
  if (!serviceAccount) return null;
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
  return admin;
}

// Cache mongoose connection promise (serverless-friendly)
if (!global._mongoPromise) {
  global._mongoPromise = mongoose
    .connect(process.env.MONGO_URI, {
      // optional mongoose settings
      // useNewUrlParser: true,
      // useUnifiedTopology: true,
    })
    .then(() => console.log("MongoDB connected"))
    .catch((err) => {
      console.error("MongoDB connection error:", err);
      throw err;
    });
}

// App factory (create & configure express app once)
async function createApp() {
  // wait for mongoose
  await global._mongoPromise;

  const app = express();
  app.use(express.json());
  app.use(cors());

  // Initialize Firebase Admin (safe)
  initFirebase();

  // Simple root for healthcheck
  app.get("/", (req, res) => res.send("API is running"));

  /* ================= AUTH ROUTES ================= */

  // REGISTER
  app.post("/auth/register", async (req, res) => {
    try {
      const { firstName, lastName, email, password } = req.body;
      const existingUser = await User.findOne({ email });
      if (existingUser) return res.status(400).json("User already exists");

      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);

      const newUser = new User({
        firstName,
        lastName,
        email,
        password: hashedPassword,
      });

      await newUser.save();
      res.status(201).json(newUser);
    } catch (err) {
      console.error(err);
      res.status(500).json("Server error");
    }
  });

  // LOGIN
  app.post("/auth/login", async (req, res) => {
    try {
      const user = await User.findOne({ email: req.body.email });
      if (!user) return res.status(404).json("User not found");

      const valid = await bcrypt.compare(req.body.password, user.password);
      if (!valid) return res.status(400).json("Wrong password");

      const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
      const { password, ...others } = user._doc;
      res.status(200).json({ token, user: others });
    } catch (err) {
      console.error(err);
      res.status(500).json("Server error");
    }
  });

  // GOOGLE AUTH (verify firebase id token)
  app.post("/auth/google", async (req, res) => {
    try {
      if (!admin.apps.length) {
        // ensure firebase admin is initialized
        initFirebase();
      }
      const { token } = req.body;
      const decoded = await admin.auth().verifyIdToken(token);
      const { email, name, picture } = decoded;

      let user = await User.findOne({ email });
      if (!user) {
        const generatedPassword =
          Math.random().toString(36).slice(-8) +
          Math.random().toString(36).slice(-8);
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(generatedPassword, salt);

        const parts = name ? name.split(" ") : ["User", "New"];
        user = new User({
          email,
          firstName: parts[0],
          lastName: parts.slice(1).join(" ") || "User",
          password: hashedPassword,
          profilePic: picture,
        });
        await user.save();
      }

      const appToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
      const { password, ...others } = user._doc;
      res.status(200).json({ token: appToken, user: others });
    } catch (err) {
      console.error("Google auth failed:", err);
      res.status(500).json("Google Auth Failed");
    }
  });

  /* ================= POSTS ================= */

  // GET FEED
  app.get("/posts", verifyToken, async (req, res) => {
    try {
      const currentUserId = req.user.id;
      const filter = {
        $or: [
          { privacy: "public" },
          { privacy: { $exists: false } },
          { userId: currentUserId },
        ],
      };

      const posts = await Post.find(filter)
        .populate("userId", "firstName lastName profilePic")
        .sort({ createdAt: -1 });

      const postsWithData = await Promise.all(
        posts.map(async (post) => {
          const myLike = await Like.findOne({
            userId: currentUserId,
            targetId: post._id,
            targetType: "Post",
          });

          const recentLikes = await Like.find({
            targetId: post._id,
            targetType: "Post",
          })
            .sort({ createdAt: -1 })
            .limit(3)
            .populate("userId", "profilePic firstName lastName");

          return {
            ...post._doc,
            isLiked: !!myLike,
            userReaction: myLike ? myLike.type : null,
            recentReactors: recentLikes.map((l) => l.userId),
          };
        })
      );

      res.status(200).json(postsWithData);
    } catch (err) {
      console.error(err);
      res.status(500).json("Server error");
    }
  });

  // CREATE POST (with optional image upload to Cloudinary)
  app.post("/posts", verifyToken, upload.single("image"), async (req, res) => {
    try {
      let imageUrl = "";
      if (req.file) {
        // Upload from buffer to cloudinary
        const result = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: "posts" },
            (error, result) => {
              if (error) return reject(error);
              resolve(result);
            }
          );
          streamifier.createReadStream(req.file.buffer).pipe(stream);
        });
        imageUrl = result.secure_url;
      }

      const newPost = new Post({
        userId: req.user.id,
        content: req.body.content,
        image: imageUrl,
        privacy: req.body.privacy || "public",
      });

      await newPost.save();
      res.status(201).json(newPost);
    } catch (err) {
      console.error(err);
      res.status(500).json("Server error");
    }
  });

  // Like/unlike simplified routes (kept from your code)
  app.put("/posts/:id/like", verifyToken, async (req, res) => {
    try {
      const postId = req.params.id;
      const userId = req.user.id;

      const existingLike = await Like.findOne({ userId, postId });
      if (existingLike) {
        await Like.findByIdAndDelete(existingLike._id);
        await Post.findByIdAndUpdate(postId, { $inc: { likesCount: -1 } });
        return res.status(200).json("Unliked");
      }

      const newLike = new Like({ userId, postId });
      await newLike.save();
      await Post.findByIdAndUpdate(postId, { $inc: { likesCount: 1 } });
      res.status(200).json("Liked");
    } catch (err) {
      console.error(err);
      res.status(500).json("Server error");
    }
  });

  // Reaction (Post & Comment)
  app.put("/api/react/:targetType/:id", verifyToken, async (req, res) => {
    try {
      const { targetType, id } = req.params;
      const { reactionType } = req.body;
      const userId = req.user.id;

      const existing = await Like.findOne({ userId, targetId: id, targetType });
      if (existing) {
        if (existing.type === reactionType) {
          await Like.findByIdAndDelete(existing._id);
          if (targetType === "Post")
            await Post.findByIdAndUpdate(id, { $inc: { likesCount: -1 } });
          else
            await Comment.findByIdAndUpdate(id, { $inc: { likesCount: -1 } });
          return res.status(200).json({ status: "removed" });
        }
        existing.type = reactionType;
        await existing.save();
        return res.status(200).json({ status: "updated", type: reactionType });
      }

      const newLike = new Like({
        userId,
        targetId: id,
        targetType,
        type: reactionType,
      });
      await newLike.save();
      if (targetType === "Post")
        await Post.findByIdAndUpdate(id, { $inc: { likesCount: 1 } });
      else
        await Comment.findByIdAndUpdate(id, { $inc: { likesCount: 1 } });

      res.status(200).json({ status: "added", type: reactionType });
    } catch (err) {
      console.error(err);
      res.status(500).json("Server error");
    }
  });

  // Fetch reacting users
  app.get("/api/react/:targetType/:id", verifyToken, async (req, res) => {
    try {
      const { targetType, id } = req.params;
      const likes = await Like.find({ targetId: id, targetType })
        .populate("userId", "firstName lastName profilePic")
        .sort({ createdAt: -1 });
      res.status(200).json(likes);
    } catch (err) {
      console.error(err);
      res.status(500).json("Server error");
    }
  });

  // Comments & replies (kept from your code)
  app.get("/posts/:id/comments", verifyToken, async (req, res) => {
    try {
      const currentUserId = req.user.id;
      const { skip = 0 } = req.query;

      const comments = await Comment.find({
        postId: req.params.id,
        parentComment: null,
      })
        .populate("userId", "firstName lastName profilePic")
        .sort({ createdAt: -1 })
        .limit(10)
        .skip(parseInt(skip));

      const commentsWithData = await Promise.all(
        comments.map(async (c) => {
          const myLike = await Like.findOne({
            userId: currentUserId,
            targetId: c._id,
            targetType: "Comment",
          });
          const recentLikes = await Like.find({
            targetId: c._id,
            targetType: "Comment",
          })
            .sort({ createdAt: -1 })
            .limit(5)
            .select("type");

          const distinctTypes = [...new Set(recentLikes.map((l) => l.type))].slice(
            0,
            2
          );

          return {
            ...c._doc,
            isLiked: !!myLike,
            userReaction: myLike ? myLike.type : null,
            topReactions: distinctTypes,
          };
        })
      );

      res.status(200).json(commentsWithData);
    } catch (err) {
      console.error(err);
      res.status(500).json("Server error");
    }
  });

  app.get("/comments/:id/replies", verifyToken, async (req, res) => {
    try {
      const currentUserId = req.user.id;
      const replies = await Comment.find({ parentComment: req.params.id })
        .populate("userId", "firstName lastName profilePic")
        .populate("replyToUser", "firstName lastName")
        .sort({ createdAt: 1 });

      const repliesWithData = await Promise.all(
        replies.map(async (r) => {
          const myLike = await Like.findOne({
            userId: currentUserId,
            targetId: r._id,
            targetType: "Comment",
          });
          const recentLikes = await Like.find({
            targetId: r._id,
            targetType: "Comment",
          })
            .sort({ createdAt: -1 })
            .limit(5)
            .select("type");

          const distinctTypes = [
            ...new Set(recentLikes.map((l) => l.type)),
          ].slice(0, 2);

          return {
            ...r._doc,
            isLiked: !!myLike,
            userReaction: myLike ? myLike.type : null,
            topReactions: distinctTypes,
          };
        })
      );

      res.status(200).json(repliesWithData);
    } catch (err) {
      console.error(err);
      res.status(500).json("Server error");
    }
  });

  app.post("/posts/:id/comments", verifyToken, async (req, res) => {
    try {
      const { content, parentId } = req.body;
      const userId = req.user.id;
      const postId = req.params.id;

      let rootCommentId = null;
      let replyToUserId = null;

      if (parentId) {
        const parent = await Comment.findById(parentId);
        if (!parent) return res.status(404).json("Comment not found");

        if (parent.parentComment) {
          rootCommentId = parent.parentComment;
          replyToUserId = parent.userId;
        } else {
          rootCommentId = parentId;
          replyToUserId = parent.userId;
        }
      }

      const newComment = new Comment({
        userId,
        postId,
        content,
        parentComment: rootCommentId,
        replyToUser: replyToUserId,
      });

      await newComment.save();
      await Post.findByIdAndUpdate(postId, { $inc: { commentsCount: 1 } });
      if (rootCommentId)
        await Comment.findByIdAndUpdate(rootCommentId, { $inc: { replyCount: 1 } });

      const populatedComment = await Comment.findById(newComment._id)
        .populate("userId", "firstName lastName profilePic")
        .populate("replyToUser", "firstName lastName");

      res.status(201).json(populatedComment);
    } catch (err) {
      console.error(err);
      res.status(500).json("Server error");
    }
  });

  return app;
}

// Vercel serverless handler - creates app once, then forwards requests
let _cachedApp = null;
module.exports = async (req, res) => {
  try {
    if (!_cachedApp) {
      _cachedApp = await createApp();
    }
    // _cachedApp is an express app (callable)
    return _cachedApp(req, res);
  } catch (err) {
    console.error("Handler init error:", err);
    res.status(500).send("Server initialization error");
  }
};
