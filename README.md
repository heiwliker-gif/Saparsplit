# SaparSplit

Приложение для планирования поездок и учёта общих расходов. Интерфейс собран на React, API работает на Node.js/Express, данные хранятся в PostgreSQL. Вход пользователей — через Google.

Поездкой можно поделиться ссылкой-приглашением из раздела **Настройки поездки → Совместный доступ**. Новый участник входит в свой Google-аккаунт и присоединяется к поездке; участники совместно видят и редактируют расходы, баланс и места. Владелец может обновить ссылку и отозвать доступ участника.

## Структура

- `client/` — React-клиент на Vite.
- `server.js` — Express API и раздача production-сборки.
- `database.js`, `db/schema.sql` — подключение к PostgreSQL и схема таблиц.
- `scripts/migrate-sqlite-to-postgres.js` — однократный перенос прежней SQLite-базы.
- `legacy/` — прежний HTML-интерфейс и SQLite-схема, оставленные для справки.

## Требования

- Node.js 22.12 или новее.
- PostgreSQL 14 или новее.
- Google OAuth Client ID для входа.

## Настройка

1. Скопируйте `env.example` в `.env` и укажите `GOOGLE_CLIENT_ID` и длинный случайный `JWT_SECRET`.
2. Поднимите PostgreSQL через Docker Compose:

   ```sh
   docker compose up -d postgres
   ```

   Либо укажите в `DATABASE_URL` адрес уже существующей PostgreSQL-базы. Если меняете `POSTGRES_PASSWORD`, используйте тот же пароль в `DATABASE_URL`.
3. В Google Cloud Console добавьте адрес сайта в **Authorized JavaScript origins**. Для разработки это `http://localhost:5173`; для production — адрес сайта.
4. Установите зависимости:

   ```sh
   npm install
   ```

Схема PostgreSQL создаётся автоматически при запуске сервера.

## Разработка

Запустите API и React dev-сервер в двух терминалах из корневой папки:

```sh
npm run dev:server
```

```sh
npm run dev
```

Откройте `http://localhost:5173`. Vite проксирует запросы `/api` на Express по адресу `http://localhost:3000`.

## GitHub Codespaces

Откройте репозиторий в Codespaces. При создании Codespace Docker Compose запустит PostgreSQL и Node.js-контейнер; зависимости устанавливаются автоматически. Создайте в корне Codespace файл `.env` с Client ID Google:

```env
GOOGLE_CLIENT_ID=ваш-client-id.apps.googleusercontent.com
```

В двух терминалах запустите API и интерфейс:

```sh
npm run dev:server
```

```sh
npm run dev
```

Откройте порт `5173` во вкладке **Ports**. Перед входом через Google добавьте полный HTTPS-адрес этого порта в **Authorized JavaScript origins** OAuth-клиента в Google Cloud Console. Адрес Codespace отличается от `localhost`.

## Production

```sh
npm run build
npm start
```

Express раздаёт файлы из `client/dist` и обслуживает API на порту `PORT` (по умолчанию 3000). Для production-сайта настройте HTTPS на хостинге или reverse proxy.

## Перенос данных из SQLite

Если в `db/saparsplit.db` есть данные из прежней версии, задайте доступ к **пустой** PostgreSQL-базе в `.env`, остановите старый сервер и выполните:

```sh
npm run migrate:sqlite
```

Скрипт перенесёт пользователей, поездки, расходы и места, сохраняя их ID. Он откажется писать в PostgreSQL, если таблицы уже содержат данные. SQLite-файлы остаются на месте; перед переносом сохраните их резервную копию.

При необходимости путь к базе задаётся переменной `SQLITE_PATH`. Переменная `VITE_MAPGL_KEY` необязательна: она позволяет указать свой публичный ключ 2GIS MapGL; если её не задать, используется ключ из прежней версии интерфейса.
