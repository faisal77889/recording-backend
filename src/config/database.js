const mongoose = require("mongoose");

const connectDB = async () =>{
    try {
        await mongoose.connect(process.env.MONGO_URI);
    } catch (error) {
        console.log("Something went wrong " + error.message)
    }
}

module.exports = connectDB;