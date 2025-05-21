const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const Video = require("../models/video");
const { promisify } = require("util");
const readFile = promisify(fs.readFile);
const unlink = promisify(fs.unlink);

const { extractAudioFromVideo } = require('../utils/extractAudio');
const { transcribeWithWhisper } = require("../utils/transcribeWithWhisper");
const { burnSubtitlesIntoVideo } = require("../utils/burnSubtitles");

const videoRouter = express.Router();

// Configuration
const BASE_URL = process.env.BASE_URL || "http://localhost:5000";
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const ALLOWED_VIDEO_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/webm' // <-- Add this
];

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Enhanced JWT Authentication Middleware
const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "Authorization header missing" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({ error: "Token not provided" });
    }

    const decoded = await jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    console.error("Authentication error:", err);
    res.status(403).json({ 
      error: "Authentication failed",
      details: err.message 
    });
  }
};

// Secure File Upload Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let uploadPath;
    if (file.fieldname === "video") {
      uploadPath = path.join(__dirname, "..", "uploads", "videos");
    } else if (file.fieldname === "thumbnail") {
      uploadPath = path.join(__dirname, "..", "uploads", "thumbnails");
    } else {
      return cb(new Error("Invalid fieldname"));
    }

    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  console.log("Incoming file:", file.fieldname, file.originalname, file.mimetype);
  if (file.fieldname === "video" && !ALLOWED_VIDEO_TYPES.includes(file.mimetype)) {
    return cb(new Error("Invalid video file type"), false);
  }
  if (file.fieldname === "thumbnail" && !ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    return cb(new Error("Invalid thumbnail image type"), false);
  }
  cb(null, true);
};


const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 2 // Max 2 files (video + thumbnail)
  }
}).fields([
  { name: "video", maxCount: 1 },
  { name: "thumbnail", maxCount: 1 }
]);

// Helper function to clean up temporary files
async function cleanupFiles(files = []) {
  try {
    await Promise.all(files.map(file => unlink(file).catch(() => {})));
  } catch (err) {
    console.error("Cleanup error:", err);
  }
}

// Upload video with processing pipeline
videoRouter.post(
  "/upload",
  authenticateUser,
  (req, res, next) => {
    upload(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: err.message });
      } else if (err) {
        return res.status(500).json({ error: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    const tempFiles = [];
    try {
      // Validate required files
      if (!req.files?.video) {
        return res.status(400).json({ error: "Video file is required" });
      }

      const videoFile = req.files.video[0];
      const videoPath = videoFile.path;
      tempFiles.push(videoPath);

      // Create necessary directories
      const audioDir = path.join(__dirname, "..", "uploads", "audios");
      const subtitleDir = path.join(__dirname, "..", "uploads", "subtitles");
      fs.mkdirSync(audioDir, { recursive: true });
      fs.mkdirSync(subtitleDir, { recursive: true });

      // Processing pipeline
      console.log("\n=== Starting Video Processing Pipeline ===");
      console.log("Video path:", videoPath);
      console.log("Audio directory:", audioDir);
      console.log("Subtitle directory:", subtitleDir);

      console.log("\n1. Extracting audio...");
      const audioPath = await extractAudioFromVideo(videoPath, audioDir);
      console.log("Audio extracted to:", audioPath);
      tempFiles.push(audioPath);

      console.log("\n2. Transcribing audio...");
      let srtPath;
      try {
        srtPath = await transcribeWithWhisper(audioPath, subtitleDir);
        console.log("Transcription completed. SRT file at:", srtPath);
        if (!fs.existsSync(srtPath)) {
          throw new Error(`Generated SRT file not found at: ${srtPath}`);
        }
        
        // Verify SRT file is not empty
        const stats = fs.statSync(srtPath);
        if (stats.size === 0) {
          throw new Error("Generated SRT file is empty");
        }
        
        tempFiles.push(srtPath);
      } catch (transcriptionError) {
        console.error("Transcription error details:", {
          error: transcriptionError.message,
          stack: transcriptionError.stack,
          stdout: transcriptionError.stdout,
          stderr: transcriptionError.stderr
        });
        throw new Error(`Transcription failed: ${transcriptionError.message}`);
      }

      console.log("\n3. Burning subtitles...");
      try {
        console.log("Starting subtitle burning process...");
        const finalVideoPath = await burnSubtitlesIntoVideo(videoPath, srtPath, path.dirname(videoPath));
        console.log("Final video created at:", finalVideoPath);

        // Verify the final video exists and has size
        const finalVideoStats = fs.statSync(finalVideoPath);
        if (finalVideoStats.size === 0) {
          throw new Error("Generated video file is empty");
        }

        console.log("\n4. Reading subtitles...");
        const subtitleText = await readFile(srtPath, "utf8");

        // Prepare thumbnail URL
        const thumbnailFile = req.files?.thumbnail?.[0];
        const thumbnailUrl = thumbnailFile 
          ? thumbnailFile.path.replace(path.join(__dirname, ".."), "").replace(/\\/g, "/")
          : "/uploads/thumbnails/default.jpg";

        // Save video to database with MP4 extension
        const newVideo = new Video({
          title: req.body.title || "Untitled Video",
          description: req.body.description || "",
          owner: req.userId,
          videoUrl: finalVideoPath.replace(path.join(__dirname, ".."), "").replace(/\\/g, "/"),
          thumbnailUrl,
          subtitle: subtitleText,
          duration: req.body.duration || 0,
          language: req.body.language || "en"
        });

        await newVideo.save();

        // Clean up temporary files (keep final video)
        await cleanupFiles(tempFiles);

        // Prepare response with correct API paths
        const downloadUrl = `${BASE_URL}/api/videos/download/${path.basename(finalVideoPath)}`;
        const streamUrl = `${BASE_URL}/api/videos/stream/${newVideo._id}`;

        res.status(201).json({
          success: true,
          message: "Video processed successfully",
          video: {
            id: newVideo._id,
            title: newVideo.title,
            videoUrl: downloadUrl,
            streamUrl,
            thumbnailUrl: `${BASE_URL}${thumbnailUrl}`,
            createdAt: newVideo.createdAt
          }
        });
      } catch (burnError) {
        console.error("Burning subtitles error:", burnError);
        throw new Error(`Burning subtitles failed: ${burnError.message}`);
      }
    } catch (err) {
      console.error("Upload error:", err);
      await cleanupFiles(tempFiles);
      res.status(500).json({ 
        error: "Video processing failed",
        details: process.env.NODE_ENV === "development" ? err.message : undefined
      });
    }
  }
);

// Secure Video Download Endpoint
videoRouter.get("/download/:filename", async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    if (!filename) {
      return res.status(400).json({ error: "Invalid filename" });
    }

    const videoPath = path.join(__dirname, "..", "uploads", "videos", filename);
    if (!fs.existsSync(videoPath)) {
      return res.status(404).json({ error: "Video not found" });
    }

    // Verify user has access to this video
    const video = await Video.findOne({ 
      videoUrl: { $regex: filename }
    });

    if (!video) {
      return res.status(403).json({ error: "Access denied" });
    }

    res.download(videoPath, `${video.title}${path.extname(filename)}`);
  } catch (err) {
    console.error("Download error:", err);
    res.status(500).json({ error: "Download failed" });
  }
});

// Video Streaming Endpoint
videoRouter.get("/stream/:videoId", async (req, res) => {
  try {
    const video = await Video.findById(req.params.videoId);
    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    // Verify ownership or implement other access control
    // if (video.owner.toString() !== req.userId) {
    //   return res.status(403).json({ error: "Access denied" });
    // }

    const videoPath = path.join(__dirname, "..", video.videoUrl);
    if (!fs.existsSync(videoPath)) {
      return res.status(404).json({ error: "Video file not found" });
    }

    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      // Handle partial content (streaming)
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = (end - start) + 1;
      const file = fs.createReadStream(videoPath, { start, end });
      const head = {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": "video/mp4",
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      // Full video download
      const head = {
        "Content-Length": fileSize,
        "Content-Type": "video/mp4",
      };
      res.writeHead(200, head);
      fs.createReadStream(videoPath).pipe(res);
    }
  } catch (err) {
    console.error("Stream error:", err);
    res.status(500).json({ error: "Streaming failed" });
  }
});

// Get user videos with pagination
videoRouter.get("/my-videos", authenticateUser, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const [videos, total] = await Promise.all([
      Video.find({ owner: req.userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Video.countDocuments({ owner: req.userId })
    ]);

    const formattedVideos = videos.map(video => ({
      id: video._id,
      title: video.title,
      thumbnailUrl: video.thumbnailUrl.startsWith("http")
        ? video.thumbnailUrl
        : `${BASE_URL}${video.thumbnailUrl}`,
      videoUrl: `${BASE_URL}/api/videos/stream/${video._id}`,
      createdAt: video.createdAt,
      duration: video.duration
    }));

    res.json({
      success: true,
      videos: formattedVideos,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error("Error fetching videos:", err);
    res.status(500).json({ 
      error: "Failed to fetch videos",
      details: process.env.NODE_ENV === "development" ? err.message : undefined
    });
  }
});

// Get single video with detailed information
videoRouter.get("/:videoId", authenticateUser, async (req, res) => {
  try {
    const video = await Video.findById(req.params.videoId)
      .populate("owner", "username email")
      .lean();

    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    // Verify ownership or implement other access control
    if (video.owner._id.toString() !== req.userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const response = {
      id: video._id,
      title: video.title,
      description: video.description,
      createdAt: video.createdAt,
      duration: video.duration,
      language: video.language,
      videoUrl: `${BASE_URL}/api/videos/stream/${video._id}`,
      downloadUrl: `${BASE_URL}/api/videos/download/${path.basename(video.videoUrl)}`,
      thumbnailUrl: video.thumbnailUrl.startsWith("http")
        ? video.thumbnailUrl
        : `${BASE_URL}${video.thumbnailUrl}`,
      subtitle: video.subtitle,
      owner: {
        id: video.owner._id,
        username: video.owner.username,
        email: video.owner.email
      }
    };

    res.json({ success: true, video: response });
  } catch (err) {
    console.error("Error fetching video:", err);
    res.status(500).json({ 
      error: "Failed to fetch video",
      details: process.env.NODE_ENV === "development" ? err.message : undefined
    });
  }
});

module.exports = videoRouter;