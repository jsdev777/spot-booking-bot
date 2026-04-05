#!/bin/bash
set -e

echo "🚀 Starting deployment process..."

IMAGE_NAME="spot-booking-bot"
IMAGE_TAG="${1:-latest}"
CONTAINER_NAME="spot-booking-bot"
IMAGE_FILE="${IMAGE_NAME}-${IMAGE_TAG}.tar"
DEPLOY_DIR="${DEPLOY_PATH:-/home/$USER/spot-booking-bot}"

cd "$DEPLOY_DIR"

# Load Docker image from tar file
if [ -f "$IMAGE_FILE" ]; then
  echo "📦 Loading Docker image from $IMAGE_FILE..."
  docker load -i "$IMAGE_FILE"
  echo "✅ Image loaded successfully"
else
  echo "❌ Error: Image file $IMAGE_FILE not found"
  exit 1
fi

# Stop and remove old container if exists
if [ "$(docker ps -aq -f name=$CONTAINER_NAME)" ]; then
  echo "🛑 Stopping existing container..."
  docker stop $CONTAINER_NAME || true
  echo "🗑️  Removing old container..."
  docker rm $CONTAINER_NAME || true
  echo "✅ Old container removed"
fi

# Run database migrations
echo "🔄 Running database migrations..."

# Debug: Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
  echo "❌ ERROR: DATABASE_URL is not set!"
  exit 1
else
  echo "✅ DATABASE_URL is set (length: ${#DATABASE_URL} chars)"
fi

docker run --rm \
  --network host \
  --entrypoint /bin/sh \
  -e DATABASE_URL="$DATABASE_URL" \
  ${IMAGE_NAME}:${IMAGE_TAG} \
  -c "npx prisma generate && npx prisma migrate deploy"

if [ $? -ne 0 ]; then
  echo "❌ Migrations failed!"
  exit 1
fi

echo "✅ Migrations completed successfully"

# Start new container
echo "🎬 Starting new container..."
docker run -d \
  --name $CONTAINER_NAME \
  --network host \
  --restart unless-stopped \
  -e DATABASE_URL="$DATABASE_URL" \
  -e BOT_TOKEN="$BOT_TOKEN" \
  -e PORT="${PORT:-3000}" \
  -e NODE_ENV=production \
  ${IMAGE_NAME}:${IMAGE_TAG}

if [ $? -ne 0 ]; then
  echo "❌ Failed to start container!"
  exit 1
fi

echo "✅ Container started successfully"

# Wait for container to be healthy
echo "⏳ Waiting for application to be ready..."
sleep 10

# Health check
if docker ps | grep -q $CONTAINER_NAME; then
  echo "✅ Container is running!"
  
  # Check if application is responding
  if curl -f http://localhost:${PORT:-3000}/health 2>/dev/null; then
    echo "✅ Health check passed!"
  else
    echo "⚠️  Warning: Health check endpoint not responding (this may be expected if no health endpoint exists)"
  fi
else
  echo "❌ Container failed to start!"
  docker logs $CONTAINER_NAME
  exit 1
fi

# Cleanup old images (keep last 3)
echo "🧹 Cleaning up old images..."
docker images ${IMAGE_NAME} --format "{{.ID}} {{.CreatedAt}}" | \
  sort -rk 2 | \
  awk 'NR>3 {print $1}' | \
  xargs -r docker rmi || true

# Remove tar file
echo "🗑️  Removing image archive..."
rm -f "$IMAGE_FILE"

echo "🎉 Deployment completed successfully!"
echo "📊 Container status:"
docker ps -f name=$CONTAINER_NAME

echo ""
echo "📝 To view logs, run: docker logs -f $CONTAINER_NAME"
