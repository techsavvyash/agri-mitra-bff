# BFF for AmakrushAI

This allows for creation and mangement of flows of the building blocks I/O for AKAI.

### TODO

- [ ] Add an OpenAPI spec for the API

### Setting up the server

1. Setup the DB

```sh
docker-compose up -d
npx prisma migrate deploy
```
