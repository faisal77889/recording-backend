const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const connectDB = require("./config/database");
const path = require("path");

const authRouter = require("./routes/auth");
const videoRouter = require("./routes/videoRouter");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: '*' }));
app.use(express.json()); // To parse incoming JSON requests

// Serve static files properly
app.use("/uploads/videos", express.static(path.join(__dirname, "uploads/videos")));
app.use("/uploads/thumbnails", express.static(path.join(__dirname, "uploads/thumbnails")));

// Optional: general catch-all in case you want to access anything else in /uploads
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Mount routers with proper prefixes
app.use("/api/auth", authRouter);
app.use("/api/videos", videoRouter);

connectDB()
    .then(() => {
        console.log("connected to the database cluster successfully");
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`Server running on http://0.0.0.0:${PORT}`);
        });
    })
    .catch((err) => {
        console.log("There might be error while connecting to the database " + err.message);
    });

