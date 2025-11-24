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
const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);

// Import Models
const User = require("./models/User");
const Post = require("./models/Post");
const Like = require("./models/Like");
const Comment = require("./models/Comment");
const verifyToken = require("./middleware/auth");

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

// Database Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.log("DB Error:", err));

// Cloudinary Config
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_KEY,
  api_secret: process.env.CLOUD_SECRET
});

// Initialize Firebase Admin
const firebaseApp = admin.apps.length
  ? admin.app()
  : admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });

module.exports = firebaseApp;

// Multer Config (memory storage for Vercel)
const storage = multer.memoryStorage();
const upload = multer({ storage });

/* ================= ROUTES ================= */

// 1. REGISTER
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
    res.status(500).json(err);
  }
});

// 2. LOGIN
app.post("/auth/login", async (req, res) => {
  try {
    const user = await User.findOne({ email: req.body.email });
    if (!user) return res.status(404).json("User not found");

    const validPassword = await bcrypt.compare(req.body.password, user.password);
    if (!validPassword) return res.status(400).json("Wrong password");

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
    const { password, ...others } = user._doc;
    res.status(200).json({ token, user: others });
  } catch (err) {
    res.status(500).json(err);
  }
});

// 3. GOOGLE AUTH
app.post("/auth/google", async (req, res) => {
  try {
    const { token } = req.body;
    const decodedToken = await admin.auth().verifyIdToken(token);
    const { email, name, picture } = decodedToken;

    let user = await User.findOne({ email });

    if (!user) {
      const generatedPassword = Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-8);
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(generatedPassword, salt);

      const nameParts = name ? name.split(" ") : ["User", "New"];
      const firstName = nameParts[0];
      const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "User";

      user = new User({
        email,
        firstName,
        lastName,
        password: hashedPassword,
        profilePic: picture,
      });
      await user.save();
    }

    const appToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
    const { password, ...others } = user._doc;

    res.status(200).json({ token: appToken, user: others });
  } catch (err) {
    console.error(err);
    res.status(500).json("Google Auth Failed");
  }
});

// 4. GET FEED
app.get("/posts", verifyToken, async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const filter = {
      $or: [
        { privacy: "public" },
        { privacy: { $exists: false } },
        { userId: currentUserId }
      ]
    };

    const posts = await Post.find(filter)
      .populate("userId", "firstName lastName profilePic")
      .sort({ createdAt: -1 });

    const postsWithData = await Promise.all(posts.map(async (post) => {
      const myLike = await Like.findOne({ userId: currentUserId, targetId: post._id, targetType: "Post" });
      const recentLikes = await Like.find({ targetId: post._id, targetType: "Post" })
        .sort({ createdAt: -1 })
        .limit(3)
        .populate("userId", "profilePic firstName lastName");

      return {
        ...post._doc,
        isLiked: !!myLike,
        userReaction: myLike ? myLike.type : null,
        recentReactors: recentLikes.map(l => l.userId)
      };
    }));

    res.status(200).json(postsWithData);
  } catch (err) {
    console.error(err);
    res.status(500).json(err);
  }
});

// 5. CREATE POST (Cloudinary Memory Upload)
app.post("/posts", verifyToken, upload.single("image"), async (req, res) => {
  try {
    let imageUrl = "";
    if (req.file) {
      const streamUpload = (reqFile) => {
        return new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream((error, result) => {
            if (result) resolve(result);
            else reject(error);
          });
          streamifier.createReadStream(reqFile.buffer).pipe(stream);
        });
      };

      const result = await streamUpload(req.file);
      imageUrl = result.secure_url;
    }

    const newPost = new Post({
      userId: req.user.id,
      content: req.body.content,
      image: imageUrl,
      privacy: req.body.privacy || "public"
    });

    await newPost.save();
    res.status(201).json(newPost);
  } catch (err) {
    console.error(err);
    res.status(500).json(err);
  }
});

// 6. LIKE / UNLIKE POST
app.put("/posts/:id/like", verifyToken, async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;

    const existingLike = await Like.findOne({ userId, postId });

    if (existingLike) {
      await Like.findByIdAndDelete(existingLike._id);
      await Post.findByIdAndUpdate(postId, { $inc: { likesCount: -1 } });
      res.status(200).json("Unliked");
    } else {
      const newLike = new Like({ userId, postId });
      await newLike.save();
      await Post.findByIdAndUpdate(postId, { $inc: { likesCount: 1 } });
      res.status(200).json("Liked");
    }
  } catch (err) {
    res.status(500).json(err);
  }
});

// 7. REACTIONS (Post & Comment)
app.put("/api/react/:targetType/:id", verifyToken, async (req, res) => {
  try {
    const { targetType, id } = req.params;
    const { reactionType } = req.body;
    const userId = req.user.id;

    const existing = await Like.findOne({ userId, targetId: id, targetType });

    if (existing) {
      if (existing.type === reactionType) {
        await Like.findByIdAndDelete(existing._id);
        if (targetType === "Post") await Post.findByIdAndUpdate(id, { $inc: { likesCount: -1 } });
        else await Comment.findByIdAndUpdate(id, { $inc: { likesCount: -1 } });
        return res.status(200).json({ status: "removed" });
      } else {
        existing.type = reactionType;
        await existing.save();
        return res.status(200).json({ status: "updated", type: reactionType });
      }
    }

    const newLike = new Like({ userId, targetId: id, targetType, type: reactionType });
    await newLike.save();
    if (targetType === "Post") await Post.findByIdAndUpdate(id, { $inc: { likesCount: 1 } });
    else await Comment.findByIdAndUpdate(id, { $inc: { likesCount: 1 } });

    res.status(200).json({ status: "added", type: reactionType });
  } catch (err) {
    res.status(500).json(err);
  }
});

// 8. GET REACTING USERS
app.get("/api/react/:targetType/:id", verifyToken, async (req, res) => {
  try {
    const { targetType, id } = req.params;
    const likes = await Like.find({ targetId: id, targetType })
      .populate("userId", "firstName lastName profilePic")
      .sort({ createdAt: -1 });

    res.status(200).json(likes);
  } catch (err) {
    res.status(500).json(err);
  }
});

// 9. COMMENTS & REPLIES
app.get("/posts/:id/comments", verifyToken, async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const { skip = 0 } = req.query;

    const comments = await Comment.find({ postId: req.params.id, parentComment: null })
      .populate("userId", "firstName lastName profilePic")
      .sort({ createdAt: -1 })
      .limit(10)
      .skip(parseInt(skip));

    const commentsWithData = await Promise.all(comments.map(async (c) => {
      const myLike = await Like.findOne({ userId: currentUserId, targetId: c._id, targetType: "Comment" });
      const recentLikes = await Like.find({ targetId: c._id, targetType: "Comment" })
        .sort({ createdAt: -1 })
        .limit(5)
        .select("type");

      const distinctTypes = [...new Set(recentLikes.map(l => l.type))].slice(0, 2);

      return {
        ...c._doc,
        isLiked: !!myLike,
        userReaction: myLike ? myLike.type : null,
        topReactions: distinctTypes
      };
    }));

    res.status(200).json(commentsWithData);
  } catch (err) {
    res.status(500).json(err);
  }
});

app.get("/comments/:id/replies", verifyToken, async (req, res) => {
  try {
    const currentUserId = req.user.id;

    const replies = await Comment.find({ parentComment: req.params.id })
      .populate("userId", "firstName lastName profilePic")
      .populate("replyToUser", "firstName lastName")
      .sort({ createdAt: 1 });

    const repliesWithData = await Promise.all(replies.map(async (r) => {
      const myLike = await Like.findOne({ userId: currentUserId, targetId: r._id, targetType: "Comment" });
      const recentLikes = await Like.find({ targetId: r._id, targetType: "Comment" })
        .sort({ createdAt: -1 })
        .limit(5)
        .select("type");

      const distinctTypes = [...new Set(recentLikes.map(l => l.type))].slice(0, 2);

      return {
        ...r._doc,
        isLiked: !!myLike,
        userReaction: myLike ? myLike.type : null,
        topReactions: distinctTypes
      };
    }));

    res.status(200).json(repliesWithData);
  } catch (err) {
    res.status(500).json(err);
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
      replyToUser: replyToUserId
    });

    await newComment.save();
    await Post.findByIdAndUpdate(postId, { $inc: { commentsCount: 1 } });
    if (rootCommentId) await Comment.findByIdAndUpdate(rootCommentId, { $inc: { replyCount: 1 } });

    const populatedComment = await Comment.findById(newComment._id)
      .populate("userId", "firstName lastName profilePic")
      .populate("replyToUser", "firstName lastName");

    res.status(201).json(populatedComment);
  } catch (err) {
    console.error(err);
    res.status(500).json(err);
  }
});

/* ================= SERVER ================= */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
