const mongoose = require("mongoose");

const PostSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  content: { type: String },
  image: { type: String },
  
  // Counters for scalability
  likesCount: { type: Number, default: 0 },
  commentsCount: { type: Number, default: 0 },

  // --- ADD THIS SECTION ---
  privacy: { 
    type: String, 
    enum: ["public", "private"], 
    default: "public" 
  }
  // ------------------------

}, { timestamps: true });

// Index for fast sorting of the feed
PostSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Post", PostSchema);