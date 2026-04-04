-- AlterTable: timestamp -> boolean
ALTER TABLE "group_chat_memberships" DROP COLUMN "group_rules_accepted_at";
ALTER TABLE "group_chat_memberships" ADD COLUMN "group_rules_accepted" BOOLEAN NOT NULL DEFAULT false;
