-- CreateTable
CREATE TABLE "community_rules" (
    "community_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_rules_pkey" PRIMARY KEY ("community_id")
);

-- AddForeignKey
ALTER TABLE "community_rules" ADD CONSTRAINT "community_rules_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
