// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {AuthorizationHash as H} from "../src/AuthorizationHash.sol";
interface VectorVm {function readFile(string calldata) external view returns(string memory);function parseJsonBytes32(string calldata,string calldata) external pure returns(bytes32);}
contract AuthorizationHashTest {
    VectorVm constant vm=VectorVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    function expected(string memory key) internal view returns(bytes32) {return vm.parseJsonBytes32(vm.readFile("../fixtures/dev/authorization-vector.json"),key);}
    function policy() internal pure returns(H.Policy memory p) {
        p.schemaVersion=1;p.taskId=bytes32(uint256(1));p.datasetHash=bytes32(uint256(2));p.actionHash=keccak256("dataset-report");
        p.metricsHash=keccak256(abi.encodePacked(keccak256("count"),keccak256("sum"),keccak256("min"),keccak256("max")));
        p.purposeHash=keccak256("commercial");p.budget=10;p.allowedAsset=address(2);
        p.requiredFactsHash=keccak256(abi.encodePacked(keccak256("service-matches-task"),keccak256("commercial-use-permitted"),keccak256("evidence-belongs-to-service")));
        p.version=1;
    }
    function quote() internal pure returns(H.Quote memory q) {
        q.schemaVersion=1;q.quoteId=bytes32(uint256(3));q.serviceHash=keccak256("dataset-report");
        q.seller=address(4);q.payee=address(4);q.asset=address(2);q.amount=10;
        q.serviceTermsHash=keccak256("Commercial use of this report is permitted.");q.expiresAt=2000000000;
    }
    function receipt() internal pure returns(H.Receipt memory r) {
        r.schemaVersion=1;r.contextHash=bytes32(uint256(5));r.purchaseEvidenceCommitment=bytes32(uint256(6));
        r.policyHash=H.policyHash(policy());r.reviewer=address(7);r.modelIdHash=keccak256("local-crypto-fixture-only");
        r.questionConfigHash=bytes32(uint256(8));r.decisionHash=keccak256("PASS");r.expiresAt=2000000000;
    }
    function grant() internal pure returns(H.Grant memory g) {
        g.schemaVersion=1;g.owner=address(9);g.executor=address(10);g.chainId=31337;g.arbiter=address(1);
        g.orderId=bytes32(uint256(11));g.asset=address(2);g.amount=10;g.contextHash=bytes32(uint256(5));
        g.preparationHash=bytes32(uint256(12));g.receiptHash=H.signingHash("IntentPass.Receipt",31337,address(1),H.receiptHash(receipt()));
        g.nonce=0;g.deadline=2000000000;g.maxUses=1;
    }
    function testPolicyMatchesTypeScriptIncludingArrays() public view {require(H.policyHash(policy())==expected(".hashes.policy"),"policy mismatch");}
    function testQuoteMatchesTypeScript() public view {
        bytes32 s=H.quoteHash(quote());require(s==expected(".hashes.quoteStruct"),"quote struct mismatch");
        require(H.signingHash("IntentPass.Quote",31337,address(1),s)==expected(".hashes.quoteSigning"),"quote domain mismatch");
    }
    function testReceiptMatchesTypeScript() public view {
        bytes32 s=H.receiptHash(receipt());require(s==expected(".hashes.receiptStruct"),"receipt struct mismatch");
        require(H.signingHash("IntentPass.Receipt",31337,address(1),s)==expected(".hashes.receiptSigning"),"receipt domain mismatch");
    }
    function testGrantMatchesTypeScript() public view {
        bytes32 s=H.grantHash(grant());require(s==expected(".hashes.grantStruct"),"grant struct mismatch");
        require(H.signingHash("IntentPass.Grant",31337,address(1),s)==expected(".hashes.grantSigning"),"grant domain mismatch");
    }
    function testFuzzNonceBinding(uint256 nonce) public pure {
        H.Grant memory g=grant();bytes32 original=H.grantHash(g);if(nonce==g.nonce)return;g.nonce=nonce;
        require(H.grantHash(g)!=original,"nonce not bound");
    }
}
