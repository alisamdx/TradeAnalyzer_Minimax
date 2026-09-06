/**
 * B1 shell. The real UI — Overview, Data, Dictionary, Chains, Account, Legacy,
 * Exceptions, Runs, Jobs — is specified in 05 and arrives from B2 onward.
 */
export function App() {
  return (
    <main className="shell">
      <h1>TradeAnalyzer 2</h1>
      <p className="lede">Data-first rebuild — stage 1, build step B1.</p>
      <p className="note">
        No generation is open yet. The dictionary, the DDL generator and the Data and Dictionary
        views land at B2.
      </p>
    </main>
  );
}
