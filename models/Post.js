const mongoose = require("mongoose");

const PostSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  content: { type: String },
  image: { type: String },
  
  // Counters for scalability
  likesCount: { type: Number, default: 0 },
  commentsCount: { type: Number, default: 0 },
  privacy: { 
    type: String, 
    enum: ["public", "private"], 
    default: "public" 
  }

}, { timestamps: true });
PostSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Post", PostSchema);