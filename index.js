require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const fs = require("fs");
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
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Multer Config (for temporary file upload)
const upload = multer({ dest: "uploads/" });

/* ================= ROUTES ================= */

// 1. REGISTER
app.post("/auth/register", async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body;
    
    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json("User already exists");

    // Hash Password
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
    
    // Exclude password from response
    const { password, ...others } = user._doc;
    res.status(200).json({ token, user: others });
  } catch (err) {
    res.status(500).json(err);
  }
});

// 4. GET FEED (Updated to include recentReactors)
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

    const postsWithData = await Promise.all(
      posts.map(async (post) => {
        const myLike = await Like.findOne({ 
            userId: currentUserId, 
            targetId: post._id, 
            targetType: "Post" 
        });

        // Get recent likers for the Avatar Stack
        const recentLikes = await Like.find({ targetId: post._id, targetType: "Post" })
            .sort({ createdAt: -1 })
            .limit(3)
            .populate("userId", "profilePic firstName lastName");

        return {
          ...post._doc,
          isLiked: !!myLike,
          userReaction: myLike ? myLike.type : null,
          // Send the USERS back for the stack
          recentReactors: recentLikes.map(l => l.userId) 
        };
      })
    );

    res.status(200).json(postsWithData);
  } catch (err) {
    console.error(err);
    res.status(500).json(err);
  }
});
app.post("/auth/google", async (req, res) => {
  try {
    const { token } = req.body;
    
    // 1. Verify Token with Firebase
    const decodedToken = await admin.auth().verifyIdToken(token);
    const { email, name, picture } = decodedToken;

    // 2. Check if user exists in MongoDB
    let user = await User.findOne({ email });

    if (!user) {
      // 3. If not, create them
      // We generate a random password because our User model requires it
      const generatedPassword = Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-8);
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(generatedPassword, salt);

      // Handle First/Last name splitting
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

    // 4. Generate Application JWT (Same as normal login)
    const appToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
    const { password, ...others } = user._doc;

    res.status(200).json({ token: appToken, user: others });

  } catch (err) {
    console.error(err);
    res.status(500).json("Google Auth Failed");
  }
});

// Update POST /posts to accept privacy field
app.post("/posts", verifyToken, upload.single("image"), async (req, res) => {
  try {
    let imageUrl = "";
    if (req.file) {
      const result = await cloudinary.uploader.upload(req.file.path);
      imageUrl = result.secure_url;
      fs.unlinkSync(req.file.path);
    }

    const newPost = new Post({
      userId: req.user.id,
      content: req.body.content,
      image: imageUrl,
      privacy: req.body.privacy || "public" // Add this line
    });

    await newPost.save();
    res.status(201).json(newPost);
  } catch (err) {
    res.status(500).json(err);
  }
});


// Route: PUT /api/react/:type/:id 
// Body: { reactionType: "Haha" }
app.put("/api/react/:targetType/:id", verifyToken, async (req, res) => {
  try {
    const { targetType, id } = req.params;
    const { reactionType } = req.body; // e.g., "Haha", "Like"
    const userId = req.user.id;

    const existing = await Like.findOne({ userId, targetId: id, targetType });

    if (existing) {
      if (existing.type === reactionType) {
        // Toggle OFF if clicking same reaction
        await Like.findByIdAndDelete(existing._id);
        if(targetType === "Post") await Post.findByIdAndUpdate(id, { $inc: { likesCount: -1 } });
        else await Comment.findByIdAndUpdate(id, { $inc: { likesCount: -1 } });
        return res.status(200).json({ status: "removed" });
      } else {
        // Change Reaction (e.g. Like -> Haha)
        existing.type = reactionType;
        await existing.save();
        return res.status(200).json({ status: "updated", type: reactionType });
      }
    }

    // New Reaction
    const newLike = new Like({ userId, targetId: id, targetType, type: reactionType });
    await newLike.save();
    if(targetType === "Post") await Post.findByIdAndUpdate(id, { $inc: { likesCount: 1 } });
    else await Comment.findByIdAndUpdate(id, { $inc: { likesCount: 1 } });
    
    res.status(200).json({ status: "added", type: reactionType });
  } catch (err) {
    res.status(500).json(err);
  }
});

// 1. GET REPLIES (Updated)
app.get("/comments/:id/replies", verifyToken, async (req, res) => {
  try {
    const currentUserId = req.user.id;
    
    const replies = await Comment.find({ parentComment: req.params.id })
      .populate("userId", "firstName lastName profilePic")
      .populate("replyToUser", "firstName lastName") 
      .sort({ createdAt: 1 }); 

    const repliesWithData = await Promise.all(replies.map(async (r) => {
      const myLike = await Like.findOne({ userId: currentUserId, targetId: r._id, targetType: "Comment" });
      
      // --- NEW: Get Top 2 Distinct Reaction Types ---
      // We fetch 5 recent likes to ensure we find at least 2 different types
      const recentLikes = await Like.find({ targetId: r._id, targetType: "Comment" })
        .sort({ createdAt: -1 })
        .limit(5)
        .select("type");
        
      // Extract unique types (e.g., ['Haha', 'Like']) and take top 2
      const distinctTypes = [...new Set(recentLikes.map(l => l.type))].slice(0, 2);

      return {
        ...r._doc,
        isLiked: !!myLike,
        userReaction: myLike ? myLike.type : null,
        topReactions: distinctTypes // <--- SEND THIS TO FRONTEND
      };
    }));

    res.status(200).json(repliesWithData);
  } catch (err) {
    res.status(500).json(err);
  }
});

// 5. LIKE / UNLIKE POST
app.put("/posts/:id/like", verifyToken, async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;

    const existingLike = await Like.findOne({ userId, postId });

    if (existingLike) {
      // Unlike
      await Like.findByIdAndDelete(existingLike._id);
      await Post.findByIdAndUpdate(postId, { $inc: { likesCount: -1 } });
      res.status(200).json("Unliked");
    } else {
      // Like
      const newLike = new Like({ userId, postId });
      await newLike.save();
      await Post.findByIdAndUpdate(postId, { $inc: { likesCount: 1 } });
      res.status(200).json("Liked");
    }
  } catch (err) {
    res.status(500).json(err);
  }
});


// GENERIC GET REACTING USERS (Post & Comment)
// GET REACTING USERS (Post & Comment)
app.get("/api/react/:targetType/:id", verifyToken, async (req, res) => {
  try {
    const { targetType, id } = req.params;
    
    // We fetch the Like document, which contains: { userId, type, ... }
    const likes = await Like.find({ targetId: id, targetType })
      .populate("userId", "firstName lastName profilePic")
      .sort({ createdAt: -1 }); // Newest reactions first
      
    res.status(200).json(likes);
  } catch (err) {
    res.status(500).json(err);
  }
});


// 2. GET ROOT COMMENTS (Updated)
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
      
      // --- NEW: Get Top 2 Distinct Reaction Types ---
      const recentLikes = await Like.find({ targetId: c._id, targetType: "Comment" })
        .sort({ createdAt: -1 })
        .limit(5)
        .select("type");
        
      const distinctTypes = [...new Set(recentLikes.map(l => l.type))].slice(0, 2);

      return {
        ...c._doc,
        isLiked: !!myLike,
        userReaction: myLike ? myLike.type : null,
        topReactions: distinctTypes // <--- SEND THIS TO FRONTEND
      };
    }));

    res.status(200).json(commentsWithData);
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
      // Find the comment we are replying to
      const parent = await Comment.findById(parentId);
      if (!parent) return res.status(404).json("Comment not found");

      // LOGIC: FLATTEN THE NESTING
      if (parent.parentComment) {
        // If the parent ALREADY has a parent, it means we are replying to a reply.
        // 1. The Root is the existing parent's parent
        rootCommentId = parent.parentComment;
        // 2. We are specifically tagging the user who wrote this sub-comment
        replyToUserId = parent.userId;
      } else {
        // If parent.parentComment is null, this is a direct reply to a Root comment
        rootCommentId = parentId;
        replyToUserId = parent.userId; // Optional: usually we don't tag the root author
      }
    }

    const newComment = new Comment({
      userId,
      postId,
      content,
      parentComment: rootCommentId, // Always points to the TOP level
      replyToUser: replyToUserId    // Points to the specific user
    });

    await newComment.save();

    // Update counts...
    await Post.findByIdAndUpdate(postId, { $inc: { commentsCount: 1 } });
    if (rootCommentId) {
      await Comment.findByIdAndUpdate(rootCommentId, { $inc: { replyCount: 1 } });
    }

    // Populate data for frontend
    const populatedComment = await Comment.findById(newComment._id)
      .populate("userId", "firstName lastName profilePic")
      .populate("replyToUser", "firstName lastName"); // Populate the tagged user

    res.status(201).json(populatedComment);
  } catch (err) {
    console.error(err);
    res.status(500).json(err);
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

