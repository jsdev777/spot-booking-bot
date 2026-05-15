#!/bin/sh
set -e

echo "🚀 Starting application entrypoint..."

# Wait until the database from DATABASE_URL accepts connections (works for Docker service names, remote hosts, etc.)
echo "⏳ Waiting for PostgreSQL..."
node ./scripts/wait-for-db.js

echo "✅ PostgreSQL is ready!"

# Run database migrations
echo "🔄 Running database migrations..."
npx prisma migrate deploy

echo "🎉 Starting NestJS application..."
exec node dist/src/main.js
