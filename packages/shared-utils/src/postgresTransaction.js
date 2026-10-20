// A transaction owns one checked-out client, including any helper queries.
export async function withPostgresTransaction(pool, operation) {
  const client = await pool.connect();
  let began = false;
  let releaseError;
  try {
    await client.query("BEGIN");
    began = true;
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (began) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError = rollbackError;
      }
    } else {
      releaseError = error;
    }
    throw error;
  } finally {
    // A failed rollback leaves connection state uncertain; discard that client.
    client.release(releaseError);
  }
}
