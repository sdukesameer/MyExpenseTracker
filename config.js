/* =====================================================================
   Runtime configuration

   This app has no bundler: index.html loads plain files, so there is no
   build step to inline an environment variable into. This file is the
   substitute — committed with working defaults, and regenerated at deploy
   time by scripts/build-config.mjs when the matching variables are set in
   Netlify.

   Everything here is PUBLIC. It is delivered to every visitor, so treat it
   as though it were printed on the front page:

     • The publishable (anon) key is designed to be public. It grants only
       what Row Level Security allows, and every table has RLS enabled.
     • The service_role key must NEVER appear here. It bypasses RLS entirely
       and belongs only in Netlify's environment, read by the functions in
       netlify/functions/.

   To point this app at a different Supabase project, either edit the
   defaults below or set SUPABASE_URL / SUPABASE_PROXY_URL /
   SUPABASE_ANON_KEY in Netlify and redeploy. No VITE_ prefix: that prefix
   means "safe to inline into a client bundle", and half these names being
   secrets makes it an actively dangerous convention to be uniform about.
   ===================================================================== */

window.APP_CONFIG = {
    // The Supabase project itself. Used by netlify/functions/* as
    // SUPABASE_URL, and it is what the proxy below forwards to.
    SUPABASE_URL: 'https://hjjpjcqzslqikopsbxwh.supabase.co',

    // A Cloudflare Worker in front of Supabase, because some Indian ISPs
    // will not route to *.supabase.co reliably. Blank to talk to Supabase
    // directly.
    SUPABASE_PROXY_URL: 'https://supabase-proxy.sdukesameer.workers.dev',

    // Publishable / anon key. Safe to commit — see the note above.
    SUPABASE_ANON_KEY: 'sb_publishable_7dJnWY2k5asHPS1qpABHjw_MeQXUpIa'
};
