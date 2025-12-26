import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/payment-db';

export async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✓ MongoDB connected:', MONGODB_URI);
  } catch (error) {
    console.error('✗ MongoDB connection error:', error.message);
    process.exit(1);
  }
}

export async function closeDB() {
  await mongoose.connection.close();
  console.log('MongoDB connection closed');
}

export default mongoose;
