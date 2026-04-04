require('dotenv').config();

const { Pool } = require('pg');

/** Тестовые правила для проверки сценария «Принимаю правила» в группе. */
const TEST_COMMUNITY_RULES = `ПРАВИЛА СООБЩЕСТВА (тест)

1. Уважайте других участников и персонал площадки.
2. Бронирования отменяйте заранее, если не можете прийти.
3. В чате — без спама, рекламы и оскорблений.
4. Следуйте расписанию и не занимайте чужие слоты.
5. За нарушения администратор может ограничить доступ к боту.

Это демонстрационный текст. После проверки замените его в таблице community_rules на реальные правила вашей группы.

Нажмите «Принимаю правила» под этим сообщением в личке с ботом (или под последним фрагментом), чтобы пользоваться ботом. Если правила пришли в группе — кнопка там же.`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('Задайте DATABASE_URL в .env');
  }

  const pool = new Pool({ connectionString: url });

  try {
    const { rows } = await pool.query(
      'SELECT id, name FROM communities ORDER BY created_at ASC',
    );

    if (rows.length === 0) {
      console.log(
        'В БД нет сообществ. Сначала добавьте бота в группу и выполните /setup.',
      );
      return;
    }

    for (const r of rows) {
      await pool.query(
        `INSERT INTO community_rules (community_id, text, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (community_id) DO UPDATE SET
           text = EXCLUDED.text,
           updated_at = NOW()`,
        [r.id, TEST_COMMUNITY_RULES],
      );
      console.log(`OK: тестовые правила для «${r.name}» (id=${r.id})`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
