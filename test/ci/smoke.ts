/**
 * CI smoke — fast gate: register, SecureJoin, bidirectional delivery, security.
 *
 *   SERVER_URL=http://127.0.0.1:8080 bun run test:ci-smoke
 */
import { parseLiveEnv, summaryAndExit } from '../live/harness';
import { resolvePeerSetup } from '../live/setup';
import { runSecuritySuite } from '../live/security';
import { runDeliverySuite } from '../live/delivery';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function main() {
    const { server, joinUri, joinTimeoutMs } = parseLiveEnv();

    console.log('\n💨 Madcore × Madmail — CI smoke');
    console.log(`   Server: ${server}\n`);

    const setup = await resolvePeerSetup(server, joinUri, joinTimeoutMs);
    if (!setup) {
        summaryAndExit();
        return;
    }

    const { account: a, accountB: b, peerEmail, mode } = setup;
    const aEmail = a.getCredentials().email;

    await runSecuritySuite(server, a, b);

    if (mode === 'local' && b) {
        await runDeliverySuite(a, b, aEmail, peerEmail);
    }

    a.disconnect();
    b?.disconnect();

    summaryAndExit();
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});