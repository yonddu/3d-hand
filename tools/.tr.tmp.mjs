globalThis.__FT = process.env.FT;
const { readTake, replay } = await import('./replay.mjs');
replay(readTake(process.argv[2]));
