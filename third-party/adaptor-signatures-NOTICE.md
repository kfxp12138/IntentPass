# Experimental adaptor runtime

The optional `tools:adaptor` build downloads and statically links libsecp256k1-zkp from BlockstreamResearch/secp256k1-zkp at commit `8e1f96c20e16bf960be6caec7f3c94acb360cdf2`. Its archive is pinned by SHA-256 in `scripts/adaptor-runtime.ts`. The project-local build preserves the upstream COPYING file alongside the executable. Source and binaries are not vendored in this repository.

The dedicated tests also download public DLC test vectors at commit `9cd9148938c616690c79d99ec6f330e213c246c5` from discreetlogcontracts/dlcspecs, pinned by SHA-256. Serialization cases are verified by the upstream C test suite; the TypeScript bridge test checks the six verification/recovery cases.

Upstream library license:

Copyright (c) 2013 Pieter Wuille

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
