// server.js - Production-Ready Dream Log Backend
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const { verifyToken, requireAuth } = require('./middleware/auth');
const db = require('./services/database');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const isDevelopment = process.env.NODE_ENV === 'development';

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://api.openai.com"],
    },
  },
  crossOriginEmbedderPolicy: !isDevelopment,
}));

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = process.env.ALLOWED_ORIGINS 
      ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
      : [process.env.FRONTEND_URL || 'http://localhost:5173'];
    
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Compression middleware
app.use(compression());

// Logging middleware
if (isDevelopment) {
  app.use(morgan('dev'));
} else {
  // Create a write stream for access logs
  const accessLogStream = fs.createWriteStream(
    path.join(__dirname, 'access.log'),
    { flags: 'a' }
  );
  app.use(morgan('combined', { stream: accessLogStream }));
}

// Rate limiting with Redis support (if available)
const createRateLimiter = (windowMs, max, message) => {
  const config = {
    windowMs: windowMs || 15 * 60 * 1000,
    max: max || 100,
    message: message || 'Too many requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({
        error: message || 'Too many requests, please try again later.',
        retryAfter: Math.ceil(windowMs / 1000)
      });
    }
  };

  // In production, you might want to use Redis store
  // if (process.env.REDIS_URL) {
  //   const RedisStore = require('rate-limit-redis');
  //   config.store = new RedisStore({
  //     client: redisClient,
  //     prefix: 'rl:',
  //   });
  // }

  return rateLimit(config);
};

// Apply rate limiters
const generalLimiter = createRateLimiter(
  parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  'Too many requests from this IP, please try again later.'
);

const storyLimiter = createRateLimiter(60 * 1000, 5, 'Story generation rate limit exceeded. Please wait a moment.');
const imageLimiter = createRateLimiter(60 * 1000, 3, 'Image generation rate limit exceeded. Please wait a moment.');
const analysisLimiter = createRateLimiter(60 * 1000, 5, 'Dream analysis rate limit exceeded. Please wait a moment.');
const ttsLimiter = createRateLimiter(60 * 1000, 10, 'Text-to-speech rate limit exceeded. Please wait a moment.');

app.use(generalLimiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Trust proxy for accurate rate limiting behind reverse proxies
app.set('trust proxy', 1);

// Health check endpoint (no auth required)
app.get('/api/health', async (req, res) => {
  let dbStatus = 'unknown';
  
  try {
    await db.prisma.$queryRaw`SELECT 1`;
    dbStatus = 'healthy';
  } catch (error) {
    dbStatus = 'unhealthy';
    console.error('Database health check failed:', error);
  }

  const healthData = {
    status: dbStatus === 'healthy' ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    uptime: process.uptime(),
    environment: process.env.NODE_ENV,
    services: {
      database: dbStatus,
      openai: !!process.env.OPENAI_API_KEY,
      firebase: !!process.env.FIREBASE_PROJECT_ID
    }
  };

  const statusCode = dbStatus === 'healthy' ? 200 : 503;
  res.status(statusCode).json(healthData);
});

// Multer setup with better error handling
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 10) * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = ['audio/wav', 'audio/webm', 'audio/mpeg', 'audio/mp4', 'audio/ogg'];
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only audio files are allowed.'), false);
    }
  }
});

// Middleware to attach database user to request
const attachDbUser = async (req, res, next) => {
  if (req.user && req.user.uid) {
    try {
      const dbUser = await db.findOrCreateUser({
        uid: req.user.uid,
        email: req.user.email,
        displayName: req.user.displayName,
        photoURL: req.user.photoURL
      });
      req.dbUser = dbUser;
    } catch (error) {
      console.error('Error attaching DB user:', error);
      // Continue without dbUser - let individual endpoints handle this
    }
  }
  next();
};

// API Configuration with validation
const API_CONFIG = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: 'https://api.openai.com/v1',
  }
};

// Validate required environment variables
const requiredEnvVars = ['OPENAI_API_KEY', 'DATABASE_URL', 'FIREBASE_PROJECT_ID'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingEnvVars.length > 0) {
  console.error('Missing required environment variables:', missingEnvVars);
  if (!isDevelopment) {
    process.exit(1);
  }
}

// Import route handlers (create these as separate modules for better organization)
// For now, including inline...

// Utility function to make API calls with retries
async function makeAPICall(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        
        // Don't retry on client errors (4xx)
        if (response.status >= 400 && response.status < 500) {
          throw new Error(`API Error: ${response.status} - ${error.message || 'Client error'}`);
        }
        
        // Retry on server errors (5xx) or rate limits
        if (i < retries - 1 && (response.status >= 500 || response.status === 429)) {
          const delay = Math.min(1000 * Math.pow(2, i), 10000); // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        throw new Error(`API Error: ${response.status} - ${error.message || 'Unknown error'}`);
      }
      
      return response.json();
    } catch (error) {
      if (i === retries - 1) throw error;
      
      // Network errors - retry
      const delay = Math.min(1000 * Math.pow(2, i), 10000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Helper function to extract story segments
function extractStorySegments(story) {
  const sentences = story.match(/[^.!?]+[.!?]+/g) || [];
  const totalSentences = sentences.length;
  
  if (totalSentences < 3) {
    return {
      beginning: story,
      middle: story,
      ending: story
    };
  }
  
  const third = Math.floor(totalSentences / 3);
  
  return {
    beginning: sentences.slice(0, third).join(' ').trim(),
    middle: sentences.slice(third, third * 2).join(' ').trim(),
    ending: sentences.slice(third * 2).join(' ').trim()
  };
}

// Dreams endpoints
app.get('/api/dreams', verifyToken, attachDbUser, async (req, res) => {
  try {
    if (!req.dbUser) {
      return res.json({ dreams: [], total: 0, hasMore: false });
    }

    const { 
      page = 1, 
      limit = 20, 
      search, 
      tags, 
      startDate, 
      endDate,
      mood,
      orderBy = 'createdAt',
      order = 'desc',
      favoritesOnly = false
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const result = await db.getDreamsByUser(req.dbUser.id, {
      skip,
      take: parseInt(limit),
      orderBy,
      order,
      search,
      tags: tags ? tags.split(',') : undefined,
      startDate,
      endDate,
      mood,
      favoritesOnly: favoritesOnly === 'true'
    });

    res.json(result);
  } catch (error) {
    console.error('Error fetching dreams:', error);
    res.status(500).json({ error: 'Failed to fetch dreams' });
  }
});

app.post('/api/dreams', verifyToken, attachDbUser, async (req, res) => {
  try {
    if (!req.dbUser) {
      return res.json({ 
        success: true, 
        message: 'Dream saved locally (guest mode)',
        dream: { ...req.body, id: Date.now().toString() }
      });
    }

    const dreamData = {
      title: req.body.title,
      dreamText: req.body.dreamText,
      date: req.body.date ? new Date(req.body.date) : new Date(),
      story: req.body.story,
      storyTone: req.body.storyTone,
      storyLength: req.body.storyLength,
      hasAudio: req.body.hasAudio || false,
      audioUrl: req.body.audioUrl,
      audioDuration: req.body.audioDuration,
      tags: req.body.tags || [],
      mood: req.body.mood,
      lucidity: req.body.lucidity,
      images: req.body.images || [],
      isFavorite: req.body.isFavorite || false
    };

    const dream = await db.createDream(req.dbUser.id, dreamData);
    
    res.json({ 
      success: true, 
      dream
    });
  } catch (error) {
    console.error('Error saving dream:', error);
    res.status(500).json({ error: 'Failed to save dream' });
  }
});

app.put('/api/dreams/:id', requireAuth, attachDbUser, async (req, res) => {
  try {
    const updates = {
      title: req.body.title,
      dreamText: req.body.dreamText,
      story: req.body.story,
      storyTone: req.body.storyTone,
      storyLength: req.body.storyLength,
      tags: req.body.tags,
      mood: req.body.mood,
      lucidity: req.body.lucidity,
      images: req.body.images
    };

    Object.keys(updates).forEach(key => 
      updates[key] === undefined && delete updates[key]
    );

    const dream = await db.updateDream(req.params.id, req.dbUser.id, updates);
    
    res.json({ 
      success: true, 
      dream
    });
  } catch (error) {
    console.error('Error updating dream:', error);
    res.status(500).json({ error: 'Failed to update dream' });
  }
});

app.patch('/api/dreams/:id/favorite', requireAuth, attachDbUser, async (req, res) => {
  try {
    const dream = await db.toggleDreamFavorite(req.params.id, req.dbUser.id);
    
    res.json({ 
      success: true, 
      dream
    });
  } catch (error) {
    console.error('Error toggling favorite:', error);
    if (error.message === 'Dream not found') {
      res.status(404).json({ error: 'Dream not found' });
    } else {
      res.status(500).json({ error: 'Failed to toggle favorite' });
    }
  }
});

app.delete('/api/dreams/:id', requireAuth, attachDbUser, async (req, res) => {
  try {
    await db.deleteDream(req.params.id, req.dbUser.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting dream:', error);
    res.status(500).json({ error: 'Failed to delete dream' });
  }
});

// Speech-to-Text endpoint
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    if (!API_CONFIG.openai.apiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const formData = new FormData();
    formData.append('file', new Blob([req.file.buffer], { type: req.file.mimetype }), 'audio.wav');
    formData.append('model', 'whisper-1');
    formData.append('language', 'en');

    const response = await fetch(`${API_CONFIG.openai.baseURL}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_CONFIG.openai.apiKey}`,
      },
      body: formData
    });

    if (!response.ok) {
      throw new Error(`Transcription failed: ${response.status}`);
    }

    const result = await response.json();
    res.json({ text: result.text });

  } catch (error) {
    console.error('Transcription error:', error);
    res.status(500).json({ error: 'Failed to transcribe audio' });
  }
});

// Title Generation endpoint
app.post('/api/generate-title', storyLimiter, async (req, res) => {
  try {
    const { dreamText } = req.body;

    if (!dreamText || dreamText.trim().length === 0) {
      return res.status(400).json({ error: 'Dream text is required' });
    }

    if (!API_CONFIG.openai.apiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const systemPrompt = `You are a creative title generator. Create a short, engaging title (3-6 words) for a fairy tale based on the dream description provided. The title should be magical, whimsical, and capture the essence of the dream. Do not use quotation marks.`;

    const response = await makeAPICall(`${API_CONFIG.openai.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_CONFIG.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Create a fairy tale title for this dream: "${dreamText}"` }
        ],
        max_tokens: 50,
        temperature: 0.8
      })
    });

    const title = response.choices[0].message.content.trim();
    res.json({ title });

  } catch (error) {
    console.error('Title generation error:', error);
    res.status(500).json({ error: 'Failed to generate title' });
  }
});

// Story Generation endpoint
app.post('/api/generate-story', storyLimiter, async (req, res) => {
  try {
    const { dreamText, tone = 'whimsical', length = 'medium' } = req.body;

    if (!dreamText || dreamText.trim().length === 0) {
      return res.status(400).json({ error: 'Dream text is required' });
    }

    if (!API_CONFIG.openai.apiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const tonePrompts = {
      whimsical: "Transform this dream into a whimsical, playful fairy tale with magical creatures, rainbow colors, and joyful adventures. Make it feel like a Disney story with wonder and delight.",
      mystical: "Transform this dream into a mystical, magical fairy tale with ancient wisdom, ethereal beings, and spiritual undertones. Include elements of wonder, mystery, and enlightenment.",
      adventurous: "Transform this dream into an adventurous, bold fairy tale with brave heroes, epic quests, and thrilling challenges. Make it exciting and action-packed with courage and triumph.",
      gentle: "Transform this dream into a gentle, soothing fairy tale with kind characters, peaceful settings, and heartwarming moments. Make it comforting, tender, and full of love.",
      mysterious: "Transform this dream into a mysterious, dark fairy tale with shadows, secrets, and intriguing plot twists. Keep it atmospheric and engaging but not too scary.",
      comedy: "Transform this dream into a mysterious, dark fairy tale with sarcastic humor, dramatic secrets, and absurd plot twists. Keep it atmospheric and intriguing, but make it funny, more spooky comedy than actual horror."
    };

    const lengthPrompts = {
      short: "150-250 words",
      medium: "300-500 words", 
      long: "600-800 words"
    };

    const systemPrompt = `You are a master storyteller who specializes in transforming dreams into captivating fairy tales. ${tonePrompts[tone] || tonePrompts.whimsical}

Guidelines:
- Create a complete, well-structured fairy tale with a clear beginning, middle, and end
- Length: ${lengthPrompts[length] || lengthPrompts.medium}
- Include vivid descriptions and engaging dialogue
- Make it appropriate for all ages
- Incorporate classic fairy tale elements (magic, transformation, resolution)
- Use the dream as core inspiration but expand creatively
- Structure the story with clear scene transitions that can be illustrated`;

    const response = await makeAPICall(`${API_CONFIG.openai.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_CONFIG.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Transform this dream into a fairy tale: "${dreamText}"` }
        ],
        max_tokens: length === 'long' ? 1200 : (length === 'short' ? 400 : 800),
        temperature: 0.8
      })
    });

    const story = response.choices[0].message.content;
    res.json({ story });

  } catch (error) {
    console.error('Story generation error:', error);
    res.status(500).json({ error: 'Failed to generate story' });
  }
});

// Dream Analysis endpoint
app.post('/api/analyze-dream', analysisLimiter, verifyToken, attachDbUser, async (req, res) => {
  try {
    const { dreamText, dreamId } = req.body;

    if (!dreamText || dreamText.trim().length === 0) {
      return res.status(400).json({ error: 'Dream text is required' });
    }

    if (!API_CONFIG.openai.apiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const systemPrompt = `You are a compassionate dream analyst with expertise in psychology and symbolism. Analyze the provided dream and offer insights into its potential meanings, symbols, and emotional significance.

Guidelines:
- Provide a thoughtful, empathetic analysis (200-300 words)
- Identify key symbols and their possible meanings
- Discuss potential emotional themes or life situations it might reflect
- Offer constructive insights without being prescriptive
- Use accessible language, avoiding excessive jargon
- Be supportive and encouraging
- Remember this is for self-reflection, not clinical diagnosis`;

    const response = await makeAPICall(`${API_CONFIG.openai.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_CONFIG.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Please analyze this dream: "${dreamText}"` }
        ],
        max_tokens: 500,
        temperature: 0.7
      })
    });

    const analysisText = response.choices[0].message.content;
    
    // Save analysis to database if user is authenticated and dreamId provided
    if (req.dbUser && dreamId) {
      const emotionKeywords = ['happy', 'sad', 'anxious', 'peaceful', 'excited', 'fearful', 'content', 'frustrated'];
      const themeKeywords = ['freedom', 'control', 'love', 'loss', 'growth', 'conflict', 'journey', 'transformation'];
      
      const lowerText = analysisText.toLowerCase();
      const emotions = emotionKeywords.filter(emotion => lowerText.includes(emotion));
      const themes = themeKeywords.filter(theme => lowerText.includes(theme));
      
      const savedAnalysis = await db.createDreamAnalysis(dreamId, req.dbUser.id, {
        analysisText,
        themes,
        emotions
      });
      
      res.json({ 
        analysis: analysisText,
        themes,
        emotions,
        saved: true,
        analysisId: savedAnalysis.id
      });
    } else {
      res.json({ 
        analysis: analysisText,
        saved: false
      });
    }

  } catch (error) {
    console.error('Dream analysis error:', error);
    res.status(500).json({ error: 'Failed to analyze dream' });
  }
});

// Image Generation endpoint
app.post('/api/generate-images', imageLimiter, async (req, res) => {
  try {
    const { story, tone = 'whimsical' } = req.body;

    if (!story || story.trim().length === 0) {
      return res.status(400).json({ error: 'Story text is required' });
    }

    if (!API_CONFIG.openai.apiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const stylePrompts = {
      whimsical: "whimsical fairy tale illustration, bright vibrant colors, Disney-style animation, magical and playful, soft lighting",
      mystical: "mystical fairy tale artwork, ethereal lighting, fantasy art style, magical realism, dreamy atmosphere",
      adventurous: "epic fantasy illustration, adventure book art style, dynamic composition, heroic and bold",
      gentle: "soft watercolor fairy tale illustration, pastel colors, gentle and peaceful, children's book style",
      mysterious: "gothic fairy tale illustration, dramatic shadows, mysterious atmosphere, dark fantasy art",
      comedy: "whimsical spooky comedy illustration, Tim Burton style, quirky characters, humorous dark fantasy"
    };

    const baseStyle = stylePrompts[tone] || stylePrompts.whimsical;
    const commonStyle = `${baseStyle}, high quality, detailed artwork, storybook illustration, beautiful composition, no text, no words, no letters, no writing, text-free illustration`;

    const segments = extractStorySegments(story);
    
    const scenes = [
      {
        name: "Scene 1",
        description: "Beginning of the story",
        prompt: `Illustrate this scene: ${segments.beginning} | Make it feel like the start of a fairy tale: introduce the main character(s) and setting clearly. | Style: ${commonStyle} | Composition: wide establishing shot, cinematic lighting, detailed storybook artwork. IMPORTANT: Do not include any text, words, letters, or writing in the image.`
      },
      {
        name: "Scene 2", 
        description: "Middle of the story",
        prompt: `Illustrate this scene: ${segments.middle} | Focus on the main action or conflict—show drama, movement, and emotions. | Style: ${commonStyle} | Composition: mid-shot or dynamic angle, detailed character expressions, high-quality fairy tale illustration. IMPORTANT: Do not include any text, words, letters, or writing in the image.`
      },
      {
        name: "Scene 3",
        description: "End of the story",
        prompt: `Illustrate this scene: ${segments.ending} | Show the resolution or magical transformation—make it feel satisfying and final. | Style: ${commonStyle}, composition: full scene, warm and complete storybook atmosphere, polished illustration. IMPORTANT: Do not include any text, words, letters, or writing in the image.`
      }
    ];

    const imagePromises = scenes.map(async (scene) => {
      try {
        const response = await makeAPICall(`${API_CONFIG.openai.baseURL}/images/generations`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${API_CONFIG.openai.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'dall-e-3',
            prompt: scene.prompt,
            size: '1024x1024',
            quality: 'standard',
            n: 1
          })
        });

        return {
          url: response.data[0].url,
          scene: scene.name,
          description: scene.description,
          prompt: scene.prompt
        };
      } catch (error) {
        console.error(`Error generating image for ${scene.name}:`, error);
        return {
          url: null,
          scene: scene.name,
          description: scene.description,
          error: true
        };
      }
    });

    const images = await Promise.all(imagePromises);
    res.json({ images });

  } catch (error) {
    console.error('Image generation error:', error);
    res.status(500).json({ error: 'Failed to generate images' });
  }
});

// Text-to-Speech endpoint
app.post('/api/text-to-speech', ttsLimiter, async (req, res) => {
  try {
    const { text, voice = 'alloy', speed = 1.0 } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Text is required' });
    }

    if (!API_CONFIG.openai.apiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
    const selectedVoice = validVoices.includes(voice) ? voice : 'alloy';

    const response = await fetch(`${API_CONFIG.openai.baseURL}/audio/speech`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_CONFIG.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice: selectedVoice,
        speed: Math.max(0.25, Math.min(4.0, speed))
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('OpenAI TTS error:', error);
      throw new Error(`TTS failed: ${response.status}`);
    }

    const audioBuffer = await response.arrayBuffer();
    
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.byteLength,
      'Cache-Control': 'public, max-age=3600'
    });

    res.send(Buffer.from(audioBuffer));

  } catch (error) {
    console.error('Text-to-speech error:', error);
    res.status(500).json({ error: 'Failed to generate speech' });
  }
});

// User statistics endpoint
app.get('/api/stats', requireAuth, attachDbUser, async (req, res) => {
  try {
    const stats = await db.getUserStats(req.dbUser.id);
    res.json(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large' });
    }
    return res.status(400).json({ error: error.message });
  }

  console.error('Unhandled error:', error);
  
  const status = error.status || 500;
  const message = isDevelopment ? error.message : 'Internal server error';
  
  res.status(status).json({ 
    error: message,
    ...(isDevelopment && { stack: error.stack })
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  console.log(`${signal} signal received: closing HTTP server`);
  
  // Stop accepting new connections
  server.close(async () => {
    console.log('HTTP server closed');
    
    // Close database connections
    try {
      await db.disconnect();
      console.log('Database connections closed');
    } catch (error) {
      console.error('Error closing database connections:', error);
    }
    
    process.exit(0);
  });
  
  // Force shutdown after 30 seconds
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 30000);
};

// Listen for termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`Dream Log Backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
  console.log(`OpenAI API: ${API_CONFIG.openai.apiKey ? 'Configured' : 'Not configured'}`);
  console.log(`Firebase Admin: ${process.env.FIREBASE_PROJECT_ID ? 'Configured' : 'Not configured'}`);
  console.log(`Database: ${process.env.DATABASE_URL ? 'Configured' : 'Not configured'}`);
});

module.exports = { app, server };