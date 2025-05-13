const mysql = require('mysql2');

const connection = mysql.createConnection({
    host: 'rds11g.isbelasoft.com',
    user: 'p3ag1',
    password: 'Umg123',
    database: 'prograiiiag1',
    port: 3306,
    ssl: false, // Desactiva SSL
    timezone: '-06:00'
});

connection.connect((err) => {
    if (err) {
        console.error('Error conectando a la base de datos: ', err.stack);
        return;
    }
    console.log('Conectado a la base de datos MySQL. ID de conexión: ' + connection.threadId);
});


module.exports = connection;

