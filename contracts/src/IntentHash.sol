// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Encoding reference only: does not implement escrow or PACT.
library IntentHash {
    struct Envelope {
        uint256 schemaVersion; uint256 chainId; address arbiter; bytes32 orderId;
        bytes32 taskId; uint256 attempt; address buyer; address seller;
        address payee; address asset; uint256 price; uint256 bond;
        bytes32 datasetHash; bytes32 serviceTermsHash; bytes32 purchaseEvidenceCommitment;
        bytes32 policyHash; address reviewer; bytes32 committeeHash; uint256 threshold;
        bytes32 deliverySchemaHash; uint256 deliveryDeadline; uint256 settlementDeadline;
        bytes32 allocationPolicyHash; bytes32 intentReleasePolicyHash; bytes32 pactPaymentPublicKeyHash;
    }
    bytes32 internal constant TYPEHASH = keccak256("IntentEnvelope(uint256 schemaVersion,uint256 chainId,address arbiter,bytes32 orderId,bytes32 taskId,uint256 attempt,address buyer,address seller,address payee,address asset,uint256 price,uint256 bond,bytes32 datasetHash,bytes32 serviceTermsHash,bytes32 purchaseEvidenceCommitment,bytes32 policyHash,address reviewer,bytes32 committeeHash,uint256 threshold,bytes32 deliverySchemaHash,uint256 deliveryDeadline,uint256 settlementDeadline,bytes32 allocationPolicyHash,bytes32 intentReleasePolicyHash,bytes32 pactPaymentPublicKeyHash)");
    function contextHash(Envelope memory e) internal pure returns (bytes32) {
        return keccak256(abi.encode(TYPEHASH, e));
    }
}
