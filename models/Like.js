const mongoose = require("mongoose");

const LikeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  targetId: { type: mongoose.Schema.Types.ObjectId, required: true }, // <--- MUST BE targetId
  targetType: { type: String, enum: ["Post", "Comment"], required: true },
  type: { type: String, default: "Like" } 
}, { timestamps: true });

// Compound index for uniqueness
LikeSchema.index({ userId: 1, targetId: 1 }, { unique: true });

module.exports = mongoose.model("Like", LikeSchema);