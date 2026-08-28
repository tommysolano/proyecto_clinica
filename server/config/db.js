const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB conectado exitosamente');
    /**
     * UN ÍNDICE QUE NO SE PUDO CONSTRUIR TIENE QUE HACER RUIDO.
     *
     * Mongoose construye los índices solo y, si falla, emite el error en este
     * evento — que por defecto no escucha nadie: el arranque sigue como si nada.
     * Es un silencio caro, porque los índices únicos son candados: el de
     * (clinic, externalId) es lo único que impide guardar el mismo mensaje
     * entrante dos veces, y un índice único NO se construye si ya hay
     * duplicados. Sin este aviso, el candado se quedaba muerto y el primer
     * síntoma habría vuelto a ser un paciente recibiendo cinco respuestas.
     */
    mongoose.connection.on('index', (err) => {
      if (err) console.error('[db] ÍNDICE NO CONSTRUIDO:', err.message);
    });
  } catch (error) {
    console.error('Error conectando a MongoDB:', error.message);
    throw error;
  }
};

module.exports = connectDB;
