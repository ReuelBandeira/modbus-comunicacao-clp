// Executado uma vez pela imagem oficial do Mongo (volume novo) via mongosh.
// Cria o usuário de aplicação com acesso restrito ao próprio banco (equivalente ao MYSQL_USER do MySQL).
const database = process.env.MONGO_APP_DATABASE;
const user = process.env.MONGO_APP_USER;
const password = process.env.MONGO_APP_PASSWORD;

db.getSiblingDB(database).createUser({
    user: user,
    pwd: password,
    roles: [{ role: 'readWrite', db: database }]
});
