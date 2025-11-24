const mongoose = require("mongoose");

const CommentSchema = new mongoose.Schema({
  postId: { type: mongoose.Schema.Types.ObjectId, ref: "Post", required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  content: { type: String, required: true },
  
  // Main Thread Parent (Always the Top-Level Comment)
  parentComment: { type: mongoose.Schema.Types.ObjectId, ref: "Comment", default: null },
  
  // NEW: Who are we specifically replying to? (For the @User tag)
  replyToUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

  likesCount: { type: Number, default: 0 },
  replyCount: { type: Number, default: 0 } 
}, { timestamps: true });

module.exports = mongoose.model("Comment", CommentSchema);