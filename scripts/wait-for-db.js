'use strict';

const { Client } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDatabase() {
  for (;;) {
    const client = new Client({
      connectionString,
      connectionTimeoutMillis: 5000,
    });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      console.log('Database is ready.');
      return;
    } catch (err) {
      console.error('Database unavailable:', err.message);
      try {
        await client.end();
      } catch {
        /* ignore */
      }
      await sleep(2000);
    }
  }
}

waitForDatabase().catch((err) => {
  console.error(err);
  process.exit(1);
});
