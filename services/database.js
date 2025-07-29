// dream-log-backend/services/database.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

class DatabaseService {
  constructor() {
    this.prisma = prisma;
  }

  // User operations
  async findOrCreateUser(firebaseUser) {
    return await this.prisma.user.upsert({
      where: { firebaseUid: firebaseUser.uid },
      update: {
        email: firebaseUser.email,
        displayName: firebaseUser.displayName,
        photoURL: firebaseUser.photoURL,
      },
      create: {
        firebaseUid: firebaseUser.uid,
        email: firebaseUser.email,
        displayName: firebaseUser.displayName,
        photoURL: firebaseUser.photoURL,
      },
    });
  }

  async getUserById(userId) {
    return await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        dreams: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });
  }

  // Dream operations
  async createDream(userId, dreamData) {
    const { images, ...mainData } = dreamData;
    
    return await this.prisma.dream.create({
      data: {
        userId,
        ...mainData,
        images: images ? {
          create: images.map(img => ({
            url: img.url,
            scene: img.scene,
            description: img.description,
            prompt: img.prompt,
          })),
        } : undefined,
      },
      include: {
        images: true,
        analyses: true,
      },
    });
  }

  async getDreamsByUser(userId, options = {}) {
    const {
      skip = 0,
      take = 20,
      orderBy = 'createdAt',
      order = 'desc',
      search,
      tags,
      startDate,
      endDate,
      mood,
      favoritesOnly = false,  // NEW PARAMETER
    } = options;

    const where = {
      userId,
      ...(favoritesOnly && { isFavorite: true }),  // NEW FILTER
      ...(search && {
        OR: [
          { dreamText: { contains: search, mode: 'insensitive' } },
          { story: { contains: search, mode: 'insensitive' } },
          { title: { contains: search, mode: 'insensitive' } },
        ],
      }),
      ...(tags && tags.length > 0 && {
        tags: { hasSome: tags },
      }),
      ...(startDate && {
        date: { gte: new Date(startDate) },
      }),
      ...(endDate && {
        date: { lte: new Date(endDate) },
      }),
      ...(mood && {
        mood: mood,
      }),
    };

    const [dreams, total] = await Promise.all([
      this.prisma.dream.findMany({
        where,
        skip,
        take,
        orderBy: { [orderBy]: order },
        include: {
          images: true,
          _count: {
            select: { analyses: true },
          },
        },
      }),
      this.prisma.dream.count({ where }),
    ]);

    return {
      dreams,
      total,
      hasMore: skip + take < total,
    };
  }

  async getDreamById(dreamId, userId) {
    return await this.prisma.dream.findFirst({
      where: {
        id: dreamId,
        userId,
      },
      include: {
        images: true,
        analyses: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });
  }

  async updateDream(dreamId, userId, updates) {
    const { images, ...mainUpdates } = updates;

    // Handle image updates if provided
    if (images !== undefined) {
      // Delete existing images
      await this.prisma.dreamImage.deleteMany({
        where: { dreamId },
      });
    }

    return await this.prisma.dream.update({
      where: {
        id: dreamId,
        userId, // Ensures user owns the dream
      },
      data: {
        ...mainUpdates,
        ...(images && {
          images: {
            create: images.map(img => ({
              url: img.url,
              scene: img.scene,
              description: img.description,
              prompt: img.prompt,
            })),
          },
        }),
      },
      include: {
        images: true,
        analyses: true,
      },
    });
  }

  // NEW METHOD: Toggle favorite status
  async toggleDreamFavorite(dreamId, userId) {
    // First get the current favorite status
    const dream = await this.prisma.dream.findFirst({
      where: {
        id: dreamId,
        userId,
      },
      select: {
        isFavorite: true,
      },
    });

    if (!dream) {
      throw new Error('Dream not found');
    }

    // Toggle the favorite status
    return await this.prisma.dream.update({
      where: {
        id: dreamId,
        userId,
      },
      data: {
        isFavorite: !dream.isFavorite,
      },
      include: {
        images: true,
        analyses: true,
      },
    });
  }

  async deleteDream(dreamId, userId) {
    return await this.prisma.dream.delete({
      where: {
        id: dreamId,
        userId, // Ensures user owns the dream
      },
    });
  }

  // Dream Analysis operations
  async createDreamAnalysis(dreamId, userId, analysisData) {
    return await this.prisma.dreamAnalysis.create({
      data: {
        dreamId,
        userId,
        ...analysisData,
      },
    });
  }

  async getDreamAnalyses(dreamId, userId) {
    return await this.prisma.dreamAnalysis.findMany({
      where: {
        dreamId,
        userId,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Analytics and statistics
  async getUserStats(userId) {
    const [
      totalDreams,
      dreamsThisMonth,
      favoriteDreams,  // NEW STAT
      mostCommonTags,
      moodDistribution,
      averageLucidity,
    ] = await Promise.all([
      this.prisma.dream.count({ where: { userId } }),
      this.prisma.dream.count({
        where: {
          userId,
          createdAt: {
            gte: new Date(new Date().setDate(1)), // First day of current month
          },
        },
      }),
      this.prisma.dream.count({ where: { userId, isFavorite: true } }),  // NEW STAT
      this.prisma.$queryRaw`
        SELECT tag, COUNT(*) as count
        FROM (
          SELECT unnest(tags) as tag
          FROM "Dream"
          WHERE "userId" = ${userId}
        ) as dream_tags
        GROUP BY tag
        ORDER BY count DESC
        LIMIT 10
      `,
      this.prisma.dream.groupBy({
        by: ['mood'],
        where: { userId, mood: { not: null } },
        _count: true,
      }),
      this.prisma.dream.aggregate({
        where: { userId, lucidity: { not: null } },
        _avg: { lucidity: true },
      }),
    ]);

    return {
      totalDreams,
      dreamsThisMonth,
      favoriteDreams,  // NEW STAT
      mostCommonTags,
      moodDistribution: moodDistribution.map(m => ({
        mood: m.mood,
        count: m._count,
      })),
      averageLucidity: averageLucidity._avg.lucidity,
    };
  }

  // Search functionality with PostgreSQL full-text search
  async searchDreams(userId, searchTerm, options = {}) {
    const { skip = 0, take = 10 } = options;

    // Use PostgreSQL's full-text search
    const dreams = await this.prisma.$queryRaw`
      SELECT 
        d.*,
        ts_rank(d.search_vector, plainto_tsquery('english', ${searchTerm})) AS rank
      FROM "Dream" d
      WHERE 
        d."userId" = ${userId}
        AND d.search_vector @@ plainto_tsquery('english', ${searchTerm})
      ORDER BY rank DESC
      OFFSET ${skip}
      LIMIT ${take}
    `;

    // Convert the raw results to match Prisma's format
    return dreams.map(dream => ({
      ...dream,
      images: [], // You'd need to fetch these separately or join them
      _count: { analyses: 0 } // Same for counts
    }));
  }

  // Cleanup and maintenance
  async cleanupOldGuestData() {
    // Delete dreams from users who haven't logged in for 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    return await this.prisma.dream.deleteMany({
      where: {
        user: {
          updatedAt: { lt: thirtyDaysAgo },
          email: { contains: '@guest.local' }, // Assuming guest emails
        },
      },
    });
  }

  async disconnect() {
    await this.prisma.$disconnect();
  }
}

module.exports = new DatabaseService();