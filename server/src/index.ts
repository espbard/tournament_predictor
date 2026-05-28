import express from 'express';
import cors from 'cors';
import path from 'path';
import { authRouter } from './routes/auth';

const app = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);

// CORS only needed in dev — in production React is served from the same origin
if (process.env.NODE_ENV !== 'production') {
  app.use(
    cors({
      origin: process.env.CLIENT_URL ?? 'http://localhost:5173',
      credentials: true,
    })
  );
}

app.use(express.json());

// API routes
app.use('/api/auth', authRouter);

// Serve built React app in production
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
