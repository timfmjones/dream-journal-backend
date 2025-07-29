/*
  Warnings:

  - You are about to drop the column `search_vector` on the `Dream` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "Dream_search_idx";

-- DropIndex
DROP INDEX "Dream_tags_idx";

-- AlterTable
ALTER TABLE "Dream" DROP COLUMN "search_vector";
