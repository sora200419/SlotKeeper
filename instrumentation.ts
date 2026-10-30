/** Runs once when the server starts, before the first request. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startStorageOrExit } = await import('@/lib/storage/start');
  await startStorageOrExit();
}
