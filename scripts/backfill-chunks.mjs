/**
 * Fill `memory_chunks` for the existing corpus.
 *
 * Run once after the chunk table exists; the maintenance tick does not chunk on
 * its own (a chunk pass embeds every long memory, which is a burst better run
 * deliberately than inside a 30-minute tick).
 *
 *   node scripts/backfill-chunks.mjs            # write
 *   node scripts/backfill-chunks.mjs --dry-run  # report only
 *   node scripts/backfill-chunks.mjs --limit=50
 *
 * Why a script and not a migration: the DDL is idempotent and cheap, but embedding
 * 880 memories is not. Coupling the two would make a schema open depend on a
 * model being loaded.
 *
 * The embedder is the same one the search lane uses (`embedTextForProject` from
 * the local WASM stack), so a chunk vector is directly comparable to a query
 * vector. If the embedder cannot load, the script reports why and exits non-zero
 * rather than writing vectors from a different space.
 */
import { DatabaseSync } from 'node:sqlite'
import { chunkMemoryText } from '../lib/core/memory-chunk.js'
import { replaceChunks } from '../lib/core/chunk-store.js'
import { ensureAdapterTables } from '../lib/core/corpus-store.js'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const limitArg = args.find(a => a.startsWith('--limit='))
const limit = limitArg === undefined ? Infinity : Number(limitArg.slice('--limit='.length))
const dbPath = process.env.MC_CORPUS
  ?? 'C:/Users/yxx/.local/share/cortexkit/magic-context-dsh-poc/memories.db'

console.log(`corpus: ${dbPath}`)
console.log(`mode  : ${dryRun ? 'dry-run' : 'write'}${limit === Infinity ? '' : ` (limit ${String(limit)})`}`)

const boot = ensureAdapterTables(dbPath)
if (boot.outcome !== 'ready') {
  console.error(`chunk table unavailable: ${boot.detail ?? 'unknown'}`)
  process.exit(1)
}

const db = new DatabaseSync(dbPath)
const rows = db.prepare('SELECT id, content, length(content) AS chars FROM memories ORDER BY id').all()

// Which memory ids actually need more than one chunk.
const needChunking = []
let totalChunks = 0
for (const row of rows) {
  const chunks = chunkMemoryText(row.content)
  totalChunks += chunks.length
  if (chunks.length > 1) needChunking.push({ id: row.id, chars: row.chars, chunks })
}
console.log(`\nmemories          ${rows.length}`)
console.log(`multi-chunk rows  ${needChunking.length}`)
console.log(`total chunks      ${totalChunks}`)

if (dryRun) {
  for (const row of needChunking.slice(0, 5)) {
    console.log(`  #${row.id} ${row.chars} chars → ${row.chunks.length} chunks`)
  }
  db.close()
  process.exit(0)
}

// The embedder comes from the plugin's own composition root, so a chunk vector is
// directly comparable to a query vector. Constructed with the SAME options the
// memory lane uses (cache dir under the store, same assets) — a different cache
// dir would mean a different model file and therefore a different vector space.
let embedder
try {
  const { openLocalEmbedder, defaultEmbeddingCacheDir } = await import('../lib/core/embedding-local.js')
  const cacheDir = process.env.MC_EMBED_CACHE ?? defaultEmbeddingCacheDir(dbPath)
  embedder = openLocalEmbedder({
    cacheDir,
    logger: { info: (m) => console.log(`  [embed] ${m}`), warn: (m) => console.warn(`  [embed] ${m}`) },
  })
} catch (error) {
  console.error(`cannot construct the local embedder: ${error instanceof Error ? error.message : String(error)}`)
  db.close()
  process.exit(1)
}

const modelId = embedder.modelId ?? 'local-embedder'
const dims = embedder.dims
console.log(`\nembedder modelId=${modelId} dims=${dims}`)

let written = 0
let failed = 0
let processed = 0
for (const row of needChunking) {
  if (processed >= limit) break
  processed += 1
  try {
    const texts = row.chunks.map(chunk => chunk.text)
    const vectors = await embedder.embed(texts)
    if (vectors.length !== texts.length) throw new Error(`embedder returned ${vectors.length} vectors for ${texts.length} chunks`)
    replaceChunks(
      db,
      row.id,
      modelId,
      row.chunks.map((chunk, index) => ({
        memoryId: row.id,
        chunkIndex: chunk.index,
        startChar: chunk.start,
        text: chunk.text,
        embedding: vectors[index],
      })),
    )
    written += row.chunks.length
    if (processed % 10 === 0) console.log(`  … ${processed}/${needChunking.length} memories, ${written} chunks`)
  } catch (error) {
    failed += 1
    console.error(`  #${row.id} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const stored = db.prepare("SELECT COUNT(*) AS c FROM memory_chunks WHERE model_id = ?").get(modelId)
console.log(`\nmemories processed ${processed}`)
console.log(`chunks written     ${written}`)
console.log(`failures           ${failed}`)
console.log(`rows now in table  ${stored.c}`)
db.close()
