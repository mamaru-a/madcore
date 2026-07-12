/**
 * CI / Actions E2E — full madcore ↔ madmail suite with local Alice↔Bob.
 *
 *   SERVER_URL=http://127.0.0.1:8080 bun run test:ci-e2e
 *
 * Optional: JOIN_URI for external peer (skips local two-party setup).
 */
import { parseLiveEnv, summaryAndExit, tryMethod } from '../live/harness';
import { resolvePeerSetup } from '../live/setup';
import { runRestSuite } from '../live/rest';
import { runSecuritySuite } from '../live/security';
import { runDeliverySuite } from '../live/delivery';
import { runQrHelpers, runSecureJoinExtras } from '../live/securejoin';
import { runProfileSuite } from '../live/profile';
import { runMessagingSuite } from '../live/messaging';
import { runMessagingReceiveSuite } from '../live/messaging-receive';
import { runWsSuite } from '../live/ws';
import { runJoinGroupSuite, runIncomingCallSuite } from '../live/two-party-extras';
import { runWebxdcSuite, runLocationSuite, runCallsSuite } from '../live/webxdc-location-calls';
import { runGroupsSuite } from '../live/groups';
import { runStoreChatSuite } from '../live/store-chat';
import { runConfigBackupSuite } from '../live/config-backup';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function main() {
    const { server, joinUri, joinTimeoutMs } = parseLiveEnv();

    console.log('\n🧪 Madcore × Madmail — full CI E2E');
    console.log(`   Server: ${server}`);
    console.log(`   Mode:   ${joinUri ? 'external peer (JOIN_URI)' : 'local Alice↔Bob'}\n`);

    console.log('── REST API ──');
    await runRestSuite(server);

    const setup = await resolvePeerSetup(server, joinUri, joinTimeoutMs);
    if (!setup) {
        summaryAndExit();
        return;
    }

    const { dc, account: a, accountB: b, contact, contactId, peerEmail, joinUri: uri, mode } = setup;
    const aEmail = a.getCredentials().email;

    console.log('\n── Security ──');
    await runSecuritySuite(server, a, b);

    if (mode === 'local' && b) {
        console.log('\n── Bidirectional delivery ──');
        await runDeliverySuite(a, b, aEmail, peerEmail);
    }

    console.log('\n── Profile ──');
    await runProfileSuite(a, contact, peerEmail);

    console.log('\n── Messaging ──');
    await runMessagingSuite(a, contact);

    if (mode === 'local' && b) {
        console.log('\n── Messaging receive (peer assertions) ──');
        await runMessagingReceiveSuite(a, b, aEmail, peerEmail, contact);
    }

    console.log('\n── WebIMAP WebSocket depth ──');
    await runWsSuite(a, 'ci');

    console.log('\n── Webxdc / location / calls ──');
    await runWebxdcSuite(a, contact, peerEmail);
    await runLocationSuite(a, peerEmail);
    await runCallsSuite(a, contact);

    if (mode === 'local' && b) {
        console.log('\n── joinGroup + acceptIncomingCall ──');
        await runJoinGroupSuite(a, b);
        await runIncomingCallSuite(a, b, contact);
    }

    console.log('\n── Groups / channels ──');
    await runGroupsSuite(a, b, peerEmail, joinTimeoutMs);

    console.log('\n── Store / chat / contacts ──');
    await runStoreChatSuite(a, peerEmail, contactId);

    console.log('\n── QR helpers ──');
    await runQrHelpers(a, uri);

    console.log('\n── Config / backup / relays ──');
    await runConfigBackupSuite(a, server);

    console.log('\n── SecureJoin extras ──');
    await runSecureJoinExtras(a, peerEmail);

    console.log('\n── Teardown ──');
    await tryMethod('disconnect', () => { a.disconnect(); });
    if (b) await tryMethod('B.disconnect', () => { b.disconnect(); });
    await tryMethod('dc.listAccounts', () => `${dc.listAccounts().length}`);
    await tryMethod('dc.findAccountByEmail', () =>
        dc.findAccountByEmail(aEmail)?.id);

    summaryAndExit();
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});