-- AlterTable
ALTER TABLE "Dream" ADD COLUMN     "isFavorite" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Dream_isFavorite_idx" ON "Dream"("isFavorite");
