import * as client from 'openid-client';
import { env } from '../../config/env.ts';

// Discovery é uma chamada de rede (busca `/.well-known/openid-configuration`
// do issuer) — cacheamos a `Configuration` resolvida no módulo em vez de
// rediscobrir a cada login. `discovery()` já lê `OIDC_CLIENT_ID`/`SECRET` e
// monta a autenticação client_secret_post por padrão, que é o que o Google
// e o Entra esperam pra Authorization Code + client confidencial.
let configuracaoPromise: Promise<client.Configuration> | undefined;

export function obterConfiguracaoOidc(): Promise<client.Configuration> {
  configuracaoPromise ??= client.discovery(
    new URL(env.OIDC_ISSUER),
    env.OIDC_CLIENT_ID,
    env.OIDC_CLIENT_SECRET,
  );
  return configuracaoPromise;
}

export { client };
