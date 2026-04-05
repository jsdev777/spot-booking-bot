<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

Telegram bot for spot booking built with [NestJS](https://github.com/nestjs/nest) framework and Prisma ORM.

## Prerequisites

- Node.js 20.x or higher
- PostgreSQL database
- Docker (for containerized deployment)
- Telegram Bot Token

## Project setup

1. Clone the repository:
```bash
git clone <repository-url>
cd spot-booking-bot
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
```

Edit `.env` file with your configuration:
```env
DATABASE_URL="postgresql://user:password@localhost:5432/spot_booking"
BOT_TOKEN="your-telegram-bot-token"
PORT=3000
```

4. Run database migrations:
```bash
npm run prisma:migrate
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Docker

### Local Development with Docker Compose

Run the application with PostgreSQL using Docker Compose:

```bash
docker-compose up -d
```

This will start both the application and PostgreSQL database.

### Build Docker Image

```bash
docker build -t spot-booking-bot:latest .
```

### Run Docker Container

```bash
docker run -d \
  --name spot-booking-bot \
  -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:password@host:5432/spot_booking" \
  -e BOT_TOKEN="your-bot-token" \
  spot-booking-bot:latest
```

## CI/CD Pipeline

This project uses GitHub Actions for continuous integration and deployment to Hetzner VPS.

### CI Workflow

Triggers on all pull requests and pushes to `main` branch:

1. **Lint and Test**
   - Runs ESLint for code quality checks
   - Executes Jest tests
   - Uploads coverage reports

2. **Build**
   - Compiles TypeScript application
   - Verifies build artifacts

### CD Workflow

Automatically deploys to Hetzner VPS when code is pushed to `main` branch:

1. **Build Docker Image** - Creates production Docker image with git SHA tag
2. **Transfer Image** - Securely transfers image to VPS via SCP
3. **Run Migrations** - Executes Prisma migrations on production database
4. **Deploy** - Starts new container with zero-downtime deployment
5. **Health Check** - Verifies application is running correctly

### Required GitHub Secrets

Configure these secrets in your GitHub repository (Settings → Secrets and variables → Actions):

| Secret | Description | Example |
|--------|-------------|---------|
| `SSH_HOST` | Hetzner VPS IP or hostname | `123.45.67.89` |
| `SSH_USER` | SSH username | `root` or `ubuntu` |
| `SSH_PRIVATE_KEY` | Private SSH key for authentication | `-----BEGIN OPENSSH PRIVATE KEY-----...` |
| `SSH_PORT` | SSH port (optional, defaults to 22) | `22` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@localhost:5432/db` |
| `BOT_TOKEN` | Telegram bot token | `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11` |
| `DEPLOY_PATH` | Deployment directory on VPS | `/home/user/spot-booking-bot` |
| `PORT` | Application port (optional, defaults to 3000) | `3000` |

### Setting Up Deployment on Hetzner VPS

1. **Ensure Docker is installed** on your Hetzner server:
```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh
```

2. **Create deployment directory**:
```bash
mkdir -p /home/user/spot-booking-bot
```

3. **Setup SSH access**:
   - Generate SSH key pair (if not already done)
   - Add public key to VPS: `~/.ssh/authorized_keys`
   - Add private key to GitHub secrets as `SSH_PRIVATE_KEY`

4. **Configure PostgreSQL** (via FastPanel):
   - Ensure database exists
   - Grant necessary privileges for migrations
   - Note the connection string for `DATABASE_URL` secret

5. **Test deployment**:
```bash
# Push to main branch or manually trigger workflow
git push origin main
```

6. **Monitor deployment**:
   - Check GitHub Actions tab for workflow status
   - SSH into VPS and check logs:
```bash
docker logs -f spot-booking-bot
```

### Manual Deployment

If you need to deploy manually without GitHub Actions:

1. Build and save Docker image:
```bash
docker build -t spot-booking-bot:latest .
docker save spot-booking-bot:latest -o spot-booking-bot.tar
```

2. Transfer to VPS:
```bash
scp spot-booking-bot.tar user@your-server:/path/to/deploy/
scp scripts/deploy.sh user@your-server:/path/to/deploy/
```

3. Deploy on VPS:
```bash
ssh user@your-server
cd /path/to/deploy/
chmod +x deploy.sh
./deploy.sh latest
```

### Rollback

To rollback to a previous version:

1. Find the image tag (git SHA) you want to rollback to
2. SSH into VPS:
```bash
docker images spot-booking-bot
docker stop spot-booking-bot
docker rm spot-booking-bot
docker run -d --name spot-booking-bot --network host \
  -e DATABASE_URL="..." \
  -e BOT_TOKEN="..." \
  spot-booking-bot:<previous-tag>
```

### Monitoring

- **Container status**: `docker ps -f name=spot-booking-bot`
- **Application logs**: `docker logs -f spot-booking-bot`
- **Resource usage**: `docker stats spot-booking-bot`
- **Health check**: `curl http://localhost:3000/health`

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
