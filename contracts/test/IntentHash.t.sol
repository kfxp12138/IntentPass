// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {IntentHash} from "../src/IntentHash.sol";
interface Vm { function readFile(string calldata) external view returns (string memory); function parseJsonBytes32(string calldata,string calldata) external pure returns(bytes32); }
contract IntentHashTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    function example() internal pure returns(IntentHash.Envelope memory e) {
        e.schemaVersion=1; e.chainId=31337; e.arbiter=address(1); e.orderId=bytes32(uint256(2));
        e.taskId=bytes32(uint256(3)); e.attempt=1; e.buyer=address(4); e.seller=address(5);
        e.payee=address(5); e.asset=address(6); e.price=10; e.bond=0; e.datasetHash=bytes32(uint256(7));
        e.serviceTermsHash=bytes32(uint256(8)); e.purchaseEvidenceCommitment=bytes32(uint256(9));
        e.policyHash=bytes32(uint256(10)); e.reviewer=address(11); e.committeeHash=bytes32(uint256(12));
        e.threshold=2; e.deliverySchemaHash=bytes32(uint256(13)); e.deliveryDeadline=2000000000;
        e.settlementDeadline=2000003600; e.allocationPolicyHash=bytes32(uint256(14));
        e.intentReleasePolicyHash=bytes32(uint256(15)); e.pactPaymentPublicKeyHash=bytes32(uint256(16));
    }
    function testMatchesTypeScriptVector() public view {
        bytes32 expected=vm.parseJsonBytes32(vm.readFile("../fixtures/dev/hash-vector.json"),".contextHash");
        require(IntentHash.contextHash(example())==expected,"TS/Solidity hash mismatch");
    }
    function testFuzzPayeeChangesContext(address payee) public pure {
        IntentHash.Envelope memory e=example(); bytes32 original=IntentHash.contextHash(e);
        if(payee==e.payee) return; e.payee=payee;
        require(original!=IntentHash.contextHash(e),"payee not bound");
    }
    function testFuzzPriceChangesContext(uint256 price) public pure {
        IntentHash.Envelope memory e=example(); bytes32 original=IntentHash.contextHash(e);
        if(price==e.price) return; e.price=price;
        require(original!=IntentHash.contextHash(e),"price not bound");
    }
}
