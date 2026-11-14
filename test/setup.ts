import { TEST_TRUSTED_PROXY_SECRET } from "./helpers/proxy";

// Unit and integration suites exercise the trusted-proxy path with a known
// test secret. Application code still has no development default.
process.env.TRUSTED_PROXY_SECRET = TEST_TRUSTED_PROXY_SECRET;
