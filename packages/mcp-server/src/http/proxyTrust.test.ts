import assert from "node:assert/strict"; import test from "node:test"; import {createProxyTrust} from "./proxyTrust.js";
test("direct requests trust no proxy",()=>assert.equal(createProxyTrust({NODE_ENV:"test"}),0));
test("production fails closed",()=>assert.throws(()=>createProxyTrust({NODE_ENV:"production"}),/requires MCP_TRUST_PROXY/));
test("trusted single-hop is bounded",()=>assert.equal(createProxyTrust({NODE_ENV:"production",MCP_TRUST_PROXY_HOPS:"1"}),1));
test("spoofed, multi-hop, malformed values reject",()=>{assert.throws(()=>createProxyTrust({NODE_ENV:"production",MCP_TRUST_PROXY_HOPS:"3"}),/between 0 and 2/);assert.throws(()=>createProxyTrust({NODE_ENV:"production",MCP_TRUST_PROXY_HOPS:"x-forwarded-for"}),/non-negative integer/);assert.throws(()=>createProxyTrust({NODE_ENV:"production",MCP_TRUST_PROXY_HOPS:"1",MCP_TRUST_PROXY_IPS:"127.0.0.1/8"}),/only one/)});
test("CIDR trust is bounded",()=>{const t=createProxyTrust({NODE_ENV:"production",MCP_TRUST_PROXY_IPS:"10.0.0.0/8"}) as (ip:string,i:number)=>boolean;assert.equal(t("10.1.2.3",0),true);assert.equal(t("192.0.2.1",0),false);assert.equal(t("10.1.2.3",3),false)});
