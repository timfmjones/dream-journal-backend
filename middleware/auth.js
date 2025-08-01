// middleware/auth.js
let auth;

try {
  const firebaseAdmin = require('../config/firebase-admin');
  auth = firebaseAdmin.auth;
} catch (error) {
  console.error('Failed to load Firebase Admin:', error);
  auth = null;
}

const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  
  if (!token) {
    // Guest mode - no user ID
    req.user = null;
    return next();
  }

  // If Firebase is not configured, skip verification
  if (!auth || typeof auth.verifyIdToken !== 'function') {
    console.warn('Firebase Auth not available - skipping token verification');
    req.user = null;
    return next();
  }

  try {
    const decodedToken = await auth.verifyIdToken(token);
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email
    };
    next();
  } catch (error) {
    console.error('Error verifying token:', error.message);
    res.status(401).json({ error: 'Invalid authentication token' });
  }
};

const requireAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // If Firebase is not configured, return error
  if (!auth || typeof auth.verifyIdToken !== 'function') {
    console.error('Firebase Auth not available');
    return res.status(503).json({ error: 'Authentication service unavailable' });
  }

  try {
    const decodedToken = await auth.verifyIdToken(token);
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email
    };
    next();
  } catch (error) {
    console.error('Error verifying token:', error.message);
    res.status(401).json({ error: 'Invalid authentication token' });
  }
};

module.exports = { verifyToken, requireAuth };