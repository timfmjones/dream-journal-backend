// config/firebase-admin.js
const admin = require('firebase-admin');
require('dotenv').config();

let auth, db;

try {
  // Check if required environment variables exist
  if (!process.env.FIREBASE_PROJECT_ID || 
      !process.env.FIREBASE_PRIVATE_KEY || 
      !process.env.FIREBASE_CLIENT_EMAIL) {
    console.error('Missing Firebase environment variables');
    console.log('FIREBASE_PROJECT_ID:', process.env.FIREBASE_PROJECT_ID ? 'Set' : 'Missing');
    console.log('FIREBASE_PRIVATE_KEY:', process.env.FIREBASE_PRIVATE_KEY ? 'Set' : 'Missing');
    console.log('FIREBASE_CLIENT_EMAIL:', process.env.FIREBASE_CLIENT_EMAIL ? 'Set' : 'Missing');
    
    // Don't throw error - let the app run without Firebase auth
    auth = {
      verifyIdToken: async () => { throw new Error('Firebase not configured'); }
    };
    db = null;
  } else {
    // Initialize Firebase Admin only if not already initialized
    if (!admin.apps.length) {
      console.log('Initializing Firebase Admin...');
      
      // Parse the private key properly
      const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
      
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          privateKey: privateKey,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        })
      });
      
      console.log('Firebase Admin initialized successfully');
    }
    
    auth = admin.auth();
    db = admin.firestore();
  }
} catch (error) {
  console.error('Firebase Admin initialization error:', error);
  console.error('Error details:', error.message);
  
  // Provide mock services so the app doesn't crash
  auth = {
    verifyIdToken: async () => { throw new Error('Firebase initialization failed'); }
  };
  db = null;
}

module.exports = { admin, auth, db };