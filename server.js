// server.js (código corregido)
const express = require('express');
const multer = require('multer');
const path = require('path');
const db = require('./database');
const nodemailer = require('nodemailer');
const mysql = require('mysql2');
const app = express();
const port = 3001;

// Configuración de Nodemailer
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'joseemmanuelfelipefranco@gmail.com',
        pass: 'mrmuwhetqsyxhend'
    }
});

async function sendSecurityAlert(subject, message, base64Image) {
    try {
        const htmlContent = `
            <b>${message.replace(/\n/g, "<br>")}</b><br><br>
            ${base64Image ? `<img src="cid:fotoPersona" style="max-width:400px; border:1px solid #ccc;">` : ''}
        `;

        const mailOptions = {
            from: 'Sistema de Seguridad <joseemmanuelfelipefranco@gmail.com>',
            to: 'joseemmanuelfelipefranco@gmail.com',
            subject,
            text: message,
            html: htmlContent,
            attachments: base64Image ? [{
                filename: 'foto.jpg',
                content: Buffer.from(base64Image, 'base64'),
                cid: 'fotoPersona' // clave para usar en el HTML con cid:
            }] : []
        };

        await transporter.sendMail(mailOptions);
        console.log('Correo de alerta enviado con imagen');
    } catch (error) {
        console.error('Error enviando correo de alerta:', error);
    }
}


// Middleware
const storage = multer.memoryStorage();
const upload = multer({ storage });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/models', express.static(path.join(__dirname, 'public/models')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Página principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Obtener empresas
app.get('/get-empresas', (req, res) => {
    db.query("SELECT id, nombre FROM empresas", (err, rows) => {
        if (err) return res.status(500).json({ error: 'Error leyendo la base de datos' });
        res.json(rows);
    });
});

app.get('/get-areas', (req, res) => {
    db.query('SELECT id, nombre FROM areas', (err, rows) => {
        if (err) return res.status(500).json({ error: 'Error leyendo áreas' });
        res.json(rows);
    });
});


// Obtener usuarios por empresa
app.get('/get-users', (req, res) => {
    const empresaId = req.query.empresaId;
    db.query("SELECT id, nombre, cedula, cargo FROM tabla_usuarios WHERE codigo_empresa = ?", [empresaId], (err, rows) => {
        if (err) return res.status(500).send('Error al obtener usuarios');
        res.json(rows);
    });
});

app.get('/get-user-id', (req, res) => {
    const { name, empresaId } = req.query;
    db.query("SELECT id FROM tabla_usuarios WHERE nombre = ? AND codigo_empresa = ?", [name, empresaId], (err, results) => {
        if (err) return res.status(500).send('Error al obtener el ID del usuario');
        if (results.length === 0) return res.status(404).send('Usuario no encontrado');
        res.json({ id: results[0].id });
    });
});

// ❌ Esta ruta ha sido eliminada (la que usaba cedula como label)

// ✅ Esta es la única versión correcta de /get-labels
app.get('/get-labels', (req, res) => {
    const empresaId = req.query.empresaId;
    db.query("SELECT nombre FROM tabla_usuarios WHERE codigo_empresa = ?", [empresaId], (err, rows) => {
        if (err) return res.status(500).send('Error leyendo la base de datos');
        const labels = rows.map(row => row.nombre);
        res.json({ labels, totalUsers: labels.length });
    });
});

app.get('/get-image', (req, res) => {
    const { name, empresaId } = req.query;
    db.query("SELECT imagen FROM tabla_usuarios WHERE nombre = ? AND codigo_empresa = ?", [name, empresaId], (err, results) => {
        if (err || results.length === 0) return res.status(404).send('Imagen no encontrada');
        res.setHeader('Content-Type', 'image/jpeg');
        res.send(results[0].imagen);
    });
});

// Subir usuario con foto y asignar área
app.post('/upload', upload.single('photo'), (req, res) => {
    const { name, cedula, cargo, empresaId, areaId } = req.body;
    const photo = req.file.buffer;

    // Evita duplicados por cédula+empresa
    db.query(
        'SELECT COUNT(*) AS count FROM tabla_usuarios WHERE cedula = ? AND codigo_empresa = ?',
        [cedula, empresaId],
        (err, results) => {
            if (err) return res.status(500).send('Error verificando la cédula');
            if (results[0].count > 0) return res.status(400).send('El usuario ya está registrado');

            // INSERT con orden EXACTO de columnas:
            // nombre, cedula, cargo, codigo_empresa, imagen, area_id
            db.query(
                `INSERT INTO tabla_usuarios
                     (nombre, cedula, cargo, codigo_empresa, imagen, area_id)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [ name, cedula, cargo, empresaId, photo, areaId ],
                (err) => {
                    if (err) {
                        console.error('INSERT tabla_usuarios fallo:', err);
                        return res.status(500).send('Error al insertar en la base de datos');
                    }
                    res.send('Usuario agregado exitosamente');
                }
            );
        }
    );
});




// Registrar entrada
app.post('/register-entry', (req, res) => {
    // 1) Desempaquetamos los datos de la petición
    const {
        usuarioId,
        empresaId,
        deviceCode,
        resultado_autenticacion,
        foto_intento
    } = req.body;
    console.log('▶ /register-entry recibida:', { usuarioId, empresaId, deviceCode });

    // Preparamos el buffer de la imagen
    const imageBuffer = foto_intento
        ? Buffer.from(foto_intento.split(',')[1], 'base64')
        : null;

    // 2) Consulta “por defecto”: usuario.area_id == dispositivo.area_id
    const checkDefault = `
    SELECT COUNT(*) AS cnt
      FROM tabla_usuarios u
      JOIN dispositivos d ON u.area_id = d.area_id
     WHERE u.id = ? AND d.device_code = ?
  `;
    db.query(checkDefault, [usuarioId, deviceCode], (err, defaultRows) => {
        if (err) {
            console.error('Error validando permisos:', err);
            return res.status(500).send('Error validando permisos');
        }
        console.log('checkDefault result:', defaultRows[0].cnt);
        if (defaultRows[0].cnt > 0) return proceed();

        // 3) Si no entra “por defecto”, chequeo de permisos especiales
        const checkPerms = `
      SELECT COUNT(*) AS cnt
        FROM permisos_acceso p
        JOIN dispositivos d ON p.area_id = d.area_id
       WHERE p.usuario_id  = ?
         AND d.device_code = ?
         AND p.autorizado  = 1
         AND p.vencimiento > NOW()
    `;
        db.query(checkPerms, [usuarioId, deviceCode], (err, permRows) => {
            if (err) {
                console.error('Error validando permisos especiales:', err);
                return res.status(500).send('Error validando permisos especiales');
            }
            console.log('checkPerms result:', permRows[0].cnt);
            if (permRows[0].cnt > 0) return proceed();
            // Si tampoco tiene permiso especial:
            return res.status(403).send('No tiene permiso para ingresar en esta área');
        });
    });

    // 4) Función interna que solo corre si pasó alguna validación
    function proceed() {
        console.log('>>> proceed() llamado para usuario', usuarioId, 'en device', deviceCode);
        const q = `
            INSERT INTO registro
            (usuario_id, empresa_id, hora_entrada, ubicacion, resultado_autenticacion, foto_intento)
            SELECT ?, ?, NOW(), ?, ?, ?
            FROM DUAL
            WHERE NOT EXISTS (
                SELECT 1
                FROM registro
                WHERE usuario_id = ?
                  AND empresa_id = ?
                  AND DATE(hora_entrada) = CURDATE()
            )
        `;
        const params = [
            usuarioId, empresaId,
            /*ubicacion*/ null, resultado_autenticacion, imageBuffer,
            usuarioId, empresaId
        ];
        db.query(q, params, (err, result) => {
            if (err) {
                console.error('INSERT registro falló:', err);
                return res
                    .status(500)
                    .send(`Error al registrar la entrada: ${err.message}`);
            }
            console.log('INSERT registro OK, affectedRows=', result.affectedRows);
            if (result.affectedRows === 0) {
                return res.status(409).send('Ya hay una entrada registrada para hoy');
            }
            res.send('Entrada registrada exitosamente');
        });
    }
});

// Registrar intento fallido
app.post('/register-failed-attempt', (req, res) => {
    const { nombre, empresaId, motivo, fotoIntento } = req.body;
    const imageBuffer = fotoIntento
        ? Buffer.from(fotoIntento.split(',')[1], 'base64')
        : null;

    console.log('⚠️ Intento fallido recibido:', { nombre, empresaId, motivo });

    const insertarIntento = `
    INSERT INTO intentos_fallidos
      (nombre, empresa_id, fecha, motivo, foto_intento)
    VALUES (?, ?, NOW(), ?, ?)
  `;
    db.query(insertarIntento, [ nombre, empresaId, motivo, imageBuffer ], (err) => {
        if (err) {
            console.error('❌ Error al insertar intento fallido:', err);
            return res.status(500).send('Error al registrar intento fallido');
        }
        console.log('✅ Intento fallido registrado.');
        res.status(201).send('Intento fallido registrado.');
    });
});


// Registrar salida
app.post('/register-exit', (req, res) => {
    const { usuarioId, empresaId, deviceCode } = req.body;

    // 0) Chequeo de permiso “por defecto”
    const checkDefault = `
        SELECT COUNT(*) AS cnt
        FROM tabla_usuarios u
                 JOIN dispositivos d ON u.area_id = d.area_id
        WHERE u.id = ? AND d.device_code = ?
    `;
    db.query(checkDefault, [usuarioId, deviceCode], (err, defaultRows) => {
        if (err) return res.status(500).send('Error validando permisos');
        if (defaultRows[0].cnt > 0) return proceedExit();

        // 1) Chequeo de permisos especiales
        const checkPerms = `
            SELECT COUNT(*) AS cnt
            FROM permisos_acceso p
                     JOIN dispositivos d ON p.area_id = d.area_id
            WHERE p.usuario_id  = ?
              AND d.device_code = ?
              AND p.autorizado  = 1
              AND p.vencimiento > NOW()
        `;
        db.query(checkPerms, [usuarioId, deviceCode], (err, permRows) => {
            if (err) return res.status(500).send('Error validando permisos especiales');
            if (permRows[0].cnt > 0) return proceedExit();
            return res.status(403).send('No tiene permiso para registrar la salida en esta área');
        });
    });

    function proceedExit() {
        // 1) Verificamos primero que exista una entrada hoy
        const checkEntry = `
      SELECT COUNT(*) AS cnt
        FROM registro
       WHERE usuario_id = ?
         AND empresa_id = ?
         AND DATE(hora_entrada) = CURDATE()
    `;
        db.query(checkEntry, [usuarioId, empresaId], (err, rows) => {
            if (err) return res.status(500).send('Error al verificar la entrada');
            if (rows[0].cnt === 0) {
                return res.status(409).send('No hay entrada para hoy');
            }

            // 2) Actualizamos hora_salida si aún no existe
            const q = `
        UPDATE registro
           SET hora_salida = NOW()
         WHERE usuario_id = ?
           AND empresa_id = ?
           AND DATE(hora_entrada) = CURDATE()
           AND hora_salida IS NULL
      `;
            db.query(q, [usuarioId, empresaId], (err, result) => {
                if (err) return res.status(500).send('Error al registrar la salida');
                if (result.affectedRows === 0) {
                    return res.status(409).send('Ya hay una salida registrada para hoy');
                }
                res.send('Salida registrada exitosamente');
            });
        });
    }
});

// Validar login admin
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const query = `SELECT * FROM admin_usuarios WHERE username = ? AND password = ?`;
    db.query(query, [username, password], (err, results) => {
        if (err) return res.status(500).send('Error del servidor');
        if (results.length > 0) res.sendStatus(200);
        else res.sendStatus(401);
    });
});

// Obtener ID por cédula
app.get('/get-user-id-by-cedula', (req, res) => {
    const { cedula, empresaId } = req.query;
    db.query("SELECT id FROM tabla_usuarios WHERE cedula = ? AND codigo_empresa = ?", [cedula, empresaId], (err, results) => {
        if (err) return res.status(500).send('Error al obtener el ID del usuario');
        if (results.length === 0) return res.status(404).send('Usuario no encontrado');
        res.json({ id: results[0].id });
    });
});

// Autorizar o actualizar permiso
app.post('/autorizar-permiso', (req, res) => {
    const { usuarioId, areaId, vencimiento } = req.body;
    const autorizadoPor = 1;

    // Validación básica
    if (!usuarioId || !areaId || !vencimiento) {
        console.error('❗ Faltan datos obligatorios:', { usuarioId, areaId, vencimiento });
        return res.status(400).send('Faltan datos obligatorios');
    }

    const fechaVencimiento = new Date(vencimiento);
    if (isNaN(fechaVencimiento.getTime())) {
        console.error('❗ Formato de fecha inválido:', vencimiento);
        return res.status(400).send('Formato de fecha inválido.');
    }

    console.log('▶ Permiso recibido:', { usuarioId, areaId, fechaVencimiento });

    // Verificar si ya existe permiso para ese usuario y área
    db.query(
        'SELECT id FROM permisos_acceso WHERE usuario_id = ? AND area_id = ?',
        [usuarioId, areaId],
        (err, results) => {
            if (err) {
                console.error('❌ Error al verificar permiso existente:', err);
                return res.status(500).send('Error al verificar permiso existente');
            }

            if (results.length > 0) {
                // Existe -> actualizar
                const permisoId = results[0].id;
                db.query(`
                    UPDATE permisos_acceso
                       SET autorizado = 1,
                           fecha_autorizacion = NOW(),
                           autorizado_por = ?,
                           vencimiento = ?
                     WHERE id = ?
                `, [autorizadoPor, fechaVencimiento, permisoId], (err) => {
                    if (err) {
                        console.error('❌ Error al actualizar el permiso:', err);
                        return res.status(500).send('Error al actualizar el permiso');
                    }
                    console.log('✅ Permiso actualizado correctamente');
                    res.send('Permiso actualizado correctamente');
                });
            } else {
                // No existe -> insertar
                db.query(`
                    INSERT INTO permisos_acceso (usuario_id, area_id, autorizado, fecha_autorizacion, autorizado_por, vencimiento)
                    VALUES (?, ?, 1, NOW(), ?, ?)
                `, [usuarioId, areaId, autorizadoPor, fechaVencimiento], (err) => {
                    if (err) {
                        console.error('❌ Error al insertar el permiso:', err);
                        return res.status(500).send('Error al insertar el permiso');
                    }
                    console.log('✅ Permiso autorizado correctamente');
                    res.send('Permiso autorizado correctamente');
                });
            }
        }
    );
});

// Revocar permiso específico por usuario y área
app.post('/revocar-permiso', (req, res) => {
    const { usuarioId, areaId } = req.body;

    if (!usuarioId || !areaId) {
        console.error('❗ Faltan datos obligatorios para revocar:', { usuarioId, areaId });
        return res.status(400).send('Faltan datos obligatorios');
    }

    db.query(
        `UPDATE permisos_acceso 
            SET autorizado = 0 
          WHERE usuario_id = ? AND area_id = ? AND vencimiento > NOW()`,
        [usuarioId, areaId],
        (err, result) => {
            if (err) {
                console.error('❌ Error al revocar el permiso:', err);
                return res.status(500).send('Error al revocar el permiso');
            }
            if (result.affectedRows === 0) {
                console.warn('⚠️ No se encontró permiso vigente para revocar:', { usuarioId, areaId });
                return res.status(404).send('No se encontró permiso vigente para revocar');
            }
            console.log('✅ Permiso revocado exitosamente');
            res.send('Permiso revocado exitosamente');
        }
    );
});




// Iniciar servidor
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

