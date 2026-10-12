// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice EIP-712 encoding reference. No custody, PACT or nonce consumption.
library AuthorizationHash {
    struct Policy {
        uint256 schemaVersion; bytes32 taskId; bytes32 datasetHash; bytes32 actionHash;
        bytes32 metricsHash; bytes32 purposeHash; uint256 budget; address allowedAsset;
        bytes32 requiredFactsHash; uint256 version;
    }
    struct Quote {
        uint256 schemaVersion; bytes32 quoteId; bytes32 serviceHash; address seller;
        address payee; address asset; uint256 amount; bytes32 serviceTermsHash; uint256 expiresAt;
    }
    struct Receipt {
        uint256 schemaVersion; bytes32 contextHash; bytes32 purchaseEvidenceCommitment;
        bytes32 policyHash; address reviewer; bytes32 modelIdHash; bytes32 questionConfigHash;
        bytes32 decisionHash; uint256 expiresAt;
    }
    struct Grant {
        uint256 schemaVersion; address owner; address executor; uint256 chainId;
        address arbiter; bytes32 orderId; address asset; uint256 amount; bytes32 contextHash;
        bytes32 preparationHash; bytes32 receiptHash; uint256 nonce; uint256 deadline; uint256 maxUses;
    }
    bytes32 internal constant POLICY_TYPE = keccak256("TaskPolicy(uint256 schemaVersion,bytes32 taskId,bytes32 datasetHash,string action,string[4] metrics,string purpose,uint256 budget,address allowedAsset,string[3] requiredFacts,uint256 version)");
    bytes32 internal constant QUOTE_TYPE = keccak256("SignedQuote(uint256 schemaVersion,bytes32 quoteId,string service,address seller,address payee,address asset,uint256 amount,bytes32 serviceTermsHash,uint256 expiresAt)");
    bytes32 internal constant RECEIPT_TYPE = keccak256("DecisionReceipt(uint256 schemaVersion,bytes32 contextHash,bytes32 purchaseEvidenceCommitment,bytes32 policyHash,address reviewer,string modelId,bytes32 questionConfigHash,string decision,uint256 expiresAt)");
    bytes32 internal constant GRANT_TYPE = keccak256("CapabilityGrant(uint256 schemaVersion,address owner,address executor,uint256 chainId,address arbiter,bytes32 orderId,address asset,uint256 amount,bytes32 contextHash,bytes32 preparationHash,bytes32 receiptHash,uint256 nonce,uint256 deadline,uint256 maxUses)");
    bytes32 internal constant DOMAIN_TYPE = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    function policyHash(Policy memory p) internal pure returns(bytes32) {return keccak256(abi.encode(POLICY_TYPE,p));}
    function quoteHash(Quote memory q) internal pure returns(bytes32) {return keccak256(abi.encode(QUOTE_TYPE,q));}
    function receiptHash(Receipt memory r) internal pure returns(bytes32) {return keccak256(abi.encode(RECEIPT_TYPE,r));}
    function grantHash(Grant memory g) internal pure returns(bytes32) {return keccak256(abi.encode(GRANT_TYPE,g));}
    function signingHash(string memory name,uint256 chainId,address arbiter,bytes32 structHash) internal pure returns(bytes32) {
        bytes32 d=keccak256(abi.encode(DOMAIN_TYPE,keccak256(bytes(name)),keccak256("1"),chainId,arbiter));
        return keccak256(abi.encodePacked(hex"1901",d,structHash));
    }
}
