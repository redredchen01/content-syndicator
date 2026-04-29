import 'dotenv/config';
import { app } from './server';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`\n🚀 Web UI is running at: http://localhost:${PORT}\n`);
});
