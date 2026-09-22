# Gator

Gator is a command-line RSS feed aggregator built with TypeScript, Node.js, PostgreSQL, Drizzle ORM, and fast-xml-parser.

## Requirements

To run Gator you need:

- Node.js
- npm
- PostgreSQL

Install the project dependencies:

```bash
npm install
npx drizzle-kit migrate
~/.gatorconfig.json
{
  "db_url": "postgres://username:password@localhost:5432/gator?sslmode=disable",
  "current_user_name": ""
}
