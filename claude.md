# CLAUDE.md - DreamSprout Backend

This file provides guidance to Claude Code (claude.ai/code) when working with the DreamSprout backend repository.

## Project Overview

DreamSprout Backend is a Node.js/Express API server that provides AI-powered dream transformation services. It integrates with OpenAI APIs for transcription, story generation, image creation, and text-to-speech, while using PostgreSQL for data persistence and Firebase for authentication.

## Tech Stack

- **Runtime**: Node.js 18+ with Express 4.18.2
- **Database**: PostgreSQL with Prisma ORM 6.12.0
- **Authentication**: Firebase Admin SDK 12.0.0
- **AI Services**: OpenAI API (GPT-4, DALL-E 3, Whisper, TTS)
- **File Handling**: Multer 1.4.5
- **Security**: Helmet, CORS, Express Rate Limit
- **Deployment**: Railway

## Development Commands

```bash
npm install              # Install dependencies
npm run dev             # Start development server with nodemon
npm start               # Start production server
npm run start:migrate   # Run migrations then start server

# Database commands
npm run db:migrate      # Run Prisma migrations (dev)
npm run db:deploy       # Deploy migrations (production)
npm run db:generate     # Generate Prisma client
npm run db:studio       # Open Prisma Studio GUI
npm run db:seed         # Seed database (if configured)

# Code quality
npm run lint            # Run ESLint
npm run lint:fix        # Fix ESLint issues
npm test                # Run tests (Jest)
```

## Environment Configuration

Create `.env` file from `.env.example`:

```env
# Server Configuration
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:5173

# OpenAI Configuration (Required)
OPENAI_API_KEY=your_openai_api_key

# Firebase Admin Configuration
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=your_service_account_email

# Database Configuration (PostgreSQL)
DATABASE_URL="postgresql://user:password@localhost:5432/dreamlog?schema=public"
DATABASE_KEY=optional_encryption_key

# Production only
JWT_SECRET=your_jwt_secret
SESSION_SECRET=your_session_secret
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
ALLOWED_ORIGINS=https://your-frontend.com
LOG_LEVEL=info
MAX_FILE_SIZE_MB=10
SENTRY_DSN=your_sentry_dsn
```

## Project Structure

```
├── config/
│   └── firebase-admin.js    # Firebase Admin initialization
├── middleware/
│   └── auth.js             # Authentication middleware
├── services/
│   └── database.js         # Prisma database service
├── prisma/
│   ├── schema.prisma       # Database schema
│   └── migrations/         # Database migrations
├── server.js               # Main application file
├── test-connection.js      # Database connection tester
└── railway.json           # Railway deployment config
```

## Database Schema

### Models

```prisma
model User {
  id            String    @id @default(cuid())
  firebaseUid   String    @unique
  email         String    @unique
  displayName   String?
  photoURL      String?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  dreams        Dream[]
  dreamAnalyses DreamAnalysis[]
}

model Dream {
  id            String    @id @default(cuid())
  userId        String
  title         String?
  dreamText     String    @db.Text
  date          DateTime  @default(now())
  story         String?   @db.Text
  storyTone     String?
  storyLength   String?
  hasAudio      Boolean   @default(false)
  audioUrl      String?
  audioDuration Int?
  isPrivate     Boolean   @default(true)
  isFavorite    Boolean   @default(false)
  tags          String[]  @default([])
  mood          String?
  lucidity      Int?      // 1-5 scale
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  user          User      @relation(...)
  images        DreamImage[]
  analyses      DreamAnalysis[]
}

model DreamImage {
  id            String    @id @default(cuid())
  dreamId       String
  url           String
  scene         String    // "Scene 1", "Scene 2", "Scene 3"
  description   String
  prompt        String?   @db.Text
  createdAt     DateTime  @default(now())
  dream         Dream     @relation(...)
}

model DreamAnalysis {
  id            String    @id @default(cuid())
  dreamId       String
  userId        String
  analysisText  String    @db.Text
  symbols       Json?
  themes        String[]
  emotions      String[]
  createdAt     DateTime  @default(now())
  dream         Dream     @relation(...)
  user          User      @relation(...)
}
```

## API Endpoints

### Health Check
```
GET /api/health
Response: { status, timestamp, version, uptime, services }
```

### Dream Management
```
GET    /api/dreams?page=1&limit=20&search=&tags=&favoritesOnly=true
POST   /api/dreams
PUT    /api/dreams/:id
PATCH  /api/dreams/:id/favorite
DELETE /api/dreams/:id
```

### AI Generation
```
POST /api/transcribe
  Body: FormData with audio file
  Response: { text }

POST /api/generate-title
  Body: { dreamText }
  Response: { title }

POST /api/generate-story
  Body: { dreamText, tone, length }
  Response: { story }

POST /api/generate-images
  Body: { story, tone }
  Response: { images: [{ url, scene, description, prompt }] }

POST /api/analyze-dream
  Body: { dreamText, dreamId? }
  Response: { analysis, themes?, emotions?, saved?, analysisId? }

POST /api/text-to-speech
  Body: { text, voice?, speed? }
  Response: Audio file (audio/mpeg)
```

### User Statistics
```
GET /api/stats
Response: { totalDreams, dreamsThisMonth, favoriteDreams, mostCommonTags, moodDistribution, averageLucidity }
```

## Key Implementation Details

### Authentication Flow
1. Frontend sends Firebase ID token in Authorization header
2. `verifyToken` middleware validates token with Firebase Admin
3. User is created/updated in PostgreSQL on first request
4. Guest mode requests have no token and limited functionality

### OpenAI Integration

#### Transcription (Whisper)
- Model: `whisper-1`
- Max file size: 10MB
- Supported formats: wav, webm, mpeg, mp4, ogg
- Language: English (configurable)

#### Story Generation (GPT-4)
- Model: `gpt-4`
- Temperature: 0.8
- Token limits: 400-1200 based on length setting
- Customized prompts for each tone

#### Image Generation (DALL-E 3)
- Model: `dall-e-3`
- Size: 1024x1024
- Quality: standard
- 3 images per story (beginning, middle, end)
- Style prompts prevent text in images

#### Dream Analysis (GPT-4)
- Model: `gpt-4`
- Temperature: 0.7
- Max tokens: 500
- Extracts themes, emotions, and symbols

#### Text-to-Speech (TTS-1)
- Model: `tts-1`
- Voices: alloy, echo, fable, onyx, nova, shimmer
- Speed: 0.25-4.0x
- Output: MP3 audio stream

### Rate Limiting

```javascript
// Default limits
General API: 100 requests / 15 minutes / IP
Story generation: 5 / minute
Image generation: 3 / minute
Dream analysis: 5 / minute
Text-to-speech: 10 / minute
```

### Error Handling
- Structured error responses with appropriate HTTP codes
- Retry logic for OpenAI API calls (3 attempts)
- Graceful degradation when services unavailable
- Detailed logging in development, minimal in production

### Security Measures
- Helmet.js for security headers
- CORS with configurable origins
- Rate limiting per endpoint
- Input validation and sanitization
- File type validation for uploads
- Authentication required for sensitive operations

## Database Operations

### Key Queries
- Dreams with pagination and filtering
- Full-text search on dream content
- User statistics aggregation
- Cascade deletes for related data
- Optimistic locking with updatedAt

### Performance Optimizations
- Indexed foreign keys and frequently queried fields
- Connection pooling via Prisma
- Efficient pagination with cursor-based options
- Selective field loading with Prisma select

## Deployment Configuration

### Railway Setup
```json
{
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "npx prisma migrate deploy && node server.js",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

### Production Considerations
- Run migrations before starting server
- Use connection pooling for PostgreSQL
- Enable compression for responses
- Implement proper logging (consider Sentry)
- Set appropriate CORS origins
- Use environment-specific rate limits

## Development Best Practices

### Code Organization
- Modular service layer (database.js)
- Middleware for cross-cutting concerns
- Consistent error handling patterns
- Async/await over callbacks

### API Design
- RESTful conventions
- Consistent response formats
- Meaningful HTTP status codes
- Detailed error messages in development

### Database Management
- Use migrations for schema changes
- Never modify migrations after deployment
- Test migrations locally first
- Keep schema.prisma as source of truth

### Testing Approach
- Unit tests for service functions
- Integration tests for API endpoints
- Mock external services in tests
- Test error scenarios

## Common Issues & Solutions

### Firebase Admin Initialization
- Ensure private key has proper newlines
- Check service account permissions
- Verify project ID matches frontend

### Database Connections
- Check DATABASE_URL format
- Ensure PostgreSQL is running
- Verify user permissions
- Test with connection script

### OpenAI API Errors
- Monitor rate limits
- Handle quota exceeded gracefully
- Implement exponential backoff
- Cache responses where appropriate

### File Upload Issues
- Verify Multer configuration
- Check file size limits
- Ensure proper MIME types
- Handle memory efficiently

## Monitoring & Debugging

### Health Checks
- Database connectivity
- Firebase service status
- OpenAI API availability
- Memory usage metrics

### Logging Strategy
- Request/response logging with Morgan
- Error stack traces in development
- Structured logs for production
- Performance metrics tracking

### Error Tracking
- Console errors in development
- Sentry integration for production
- User-friendly error messages
- Correlation IDs for debugging

## Future Enhancements

- WebSocket support for real-time features
- Background job processing (Bull/Redis)
- Advanced caching strategies
- GraphQL API option
- Batch operations support
- Webhook integrations
- Multi-language support
- Advanced search with Elasticsearch
- Media storage optimization
- API versioning strategy