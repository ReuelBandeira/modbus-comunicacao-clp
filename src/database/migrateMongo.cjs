const { connectMongo } = require('./mongo');

// connectMongo já garante os índices (ver mongo.ts); este script serve para preparar o
// banco sem subir a API/IHM, ou para recriar o índice após uma limpeza manual (ex.: drop
// de collection no Compass).
async function migrate() {
    const { client } = await connectMongo();
    try {
        console.log('Índices garantidos.');
    } finally {
        await client.close();
    }
}

migrate().catch(error => {
    console.error('Falha ao preparar o banco. Verifique o banco, as permissões e o .env. Código:', error.code || 'MIGRATION_ERROR');
    process.exitCode = 1;
});
