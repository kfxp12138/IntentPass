// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IntentHash} from "./IntentHash.sol";
import {AuthorizationHash as H} from "./AuthorizationHash.sol";
import {IAssetEligibility} from "./IAssetEligibility.sol";

/// @notice PACT-inspired conditional escrow for Monad; NOT IMAS/CDAS or Full PACT.
/// No admin withdrawal, proxy, or mutable signer/committee/asset/eligibility policy.
contract ContextVoteEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum State { UNREGISTERED, FUNDED, EVIDENCE_FROZEN, CERTIFIED, ALLOCATED_PAID, ALLOCATED_REFUND, ALLOCATED_COMPENSATION }
    struct Order {
        bytes32 contextHash; address buyer; address seller; address payee;
        uint256 price; uint256 bond; uint256 deliveryDeadline; uint256 settlementDeadline;
        bytes32 datasetHash; bytes32 serviceTermsHash; bytes32 evidenceHash;
        uint8 voteMask; State state;
    }
    struct Delivery { uint256 schemaVersion; bytes32 orderId; bytes32 datasetHash; bytes32 reportHash; bytes32 serviceTermsHash; }
    IERC20 public immutable asset;
    IAssetEligibility public immutable eligibility;
    address public immutable reviewer;
    address[3] public committee;
    bytes32 public immutable committeeHash;
    bytes32 public constant ALLOCATION_POLICY = keccak256("intentpass.context-vote-escrow.allocation.v1");
    bytes32 public constant RELEASE_POLICY = keccak256("intentpass.context-vote-escrow.release.v1");
    bytes32 public constant PREPARATION_TAG = keccak256("IntentPass.ContextVotePreparation.v1");
    bytes32 public constant DELIVERY_SCHEMA = keccak256("DeliveryRecord(uint256 schemaVersion,bytes32 orderId,bytes32 datasetHash,bytes32 reportHash,bytes32 serviceTermsHash)");
    bytes32 public constant VOTE_TYPE = keccak256("AcceptanceVote(bytes32 orderId,bytes32 contextHash,bytes32 evidenceHash,bytes32 committeeHash,uint256 expiresAt)");
    mapping(bytes32 => Order) public orders;
    mapping(address => mapping(uint256 => bool)) public consumed;
    mapping(address => mapping(uint256 => bool)) public revoked;
    mapping(bytes32 => mapping(address => uint256)) public credits;
    mapping(bytes32 => mapping(address => uint256)) public withdrawn;
    uint256 public locked;
    uint256 public outstanding;
    error ContextMismatch(); error InvalidSignature(); error InvalidConfiguration();
    error AlreadyConsumed(); error AuthorizationRevoked(); error Expired();
    error InvalidState(); error IdentityBlocked(); error WrongExecutor();
    error InvalidDelivery(); error InvalidVote(); error TransferAmountMismatch(); error NoCredit();
    event Funded(bytes32 indexed orderId, bytes32 contextHash, address buyer, uint256 amount);
    event EvidenceFrozen(bytes32 indexed orderId, bytes32 evidenceHash);
    event Accepted(bytes32 indexed orderId, uint256 committeeIndex, bytes32 evidenceHash);
    event Certified(bytes32 indexed orderId);
    event Allocated(bytes32 indexed orderId, State state, uint256 buyerCredit, uint256 payeeCredit);
    event Withdrawn(bytes32 indexed orderId, address indexed beneficiary, uint256 amount);
    event Revoked(address indexed owner, uint256 nonce);

    constructor(address token, address gate, address reviewSigner, address[3] memory members) {
        if(token.code.length==0 || gate.code.length==0 || reviewSigner==address(0)) revert InvalidConfiguration();
        for(uint256 i; i<3; ++i) {
            if(members[i]==address(0)) revert InvalidConfiguration();
            for(uint256 j; j<i; ++j) if(members[i]==members[j]) revert InvalidConfiguration();
        }
        asset=IERC20(token); eligibility=IAssetEligibility(gate); reviewer=reviewSigner;
        committee=members; committeeHash=keccak256(abi.encode(members));
    }
    function preparationHash(bytes32 context) public view returns(bytes32) {
        return keccak256(abi.encode(PREPARATION_TAG, context, committeeHash, uint256(2)));
    }
    function revoke(uint256 nonce) external {
        if(consumed[msg.sender][nonce]) revert AlreadyConsumed();
        revoked[msg.sender][nonce]=true; emit Revoked(msg.sender,nonce);
    }
    function submit(IntentHash.Envelope calldata e, H.Receipt calldata r, bytes calldata reviewSignature,
        H.Grant calldata g, bytes calldata ownerSignature, H.Quote calldata q, bytes calldata quoteSignature)
        external nonReentrant {
        if(orders[e.orderId].state!=State.UNREGISTERED || consumed[e.buyer][g.nonce]) revert AlreadyConsumed();
        if(revoked[e.buyer][g.nonce]) revert AuthorizationRevoked();
        if(msg.sender!=g.executor) revert WrongExecutor();
        _checkEnvelope(e);
        bytes32 context=IntentHash.contextHash(e);
        bytes32 receiptDigest=H.signingHash("IntentPass.Receipt",block.chainid,address(this),H.receiptHash(r));
        if(r.schemaVersion!=1 || r.contextHash!=context || r.policyHash!=e.policyHash || r.purchaseEvidenceCommitment!=e.purchaseEvidenceCommitment
            || r.reviewer!=reviewer || r.decisionHash!=keccak256("PASS") || r.modelIdHash==bytes32(0) || r.questionConfigHash==bytes32(0)) revert ContextMismatch();
        if(r.expiresAt<block.timestamp || g.deadline<block.timestamp || q.expiresAt<block.timestamp) revert Expired();
        if(!SignatureChecker.isValidSignatureNow(reviewer,receiptDigest,reviewSignature)) revert InvalidSignature();
        if(g.schemaVersion!=1 || g.owner!=e.buyer || g.chainId!=block.chainid || g.arbiter!=address(this)
            || g.orderId!=e.orderId || g.asset!=address(asset) || g.amount!=e.price+e.bond || g.contextHash!=context
            || g.preparationHash!=preparationHash(context) || g.receiptHash!=receiptDigest || g.maxUses!=1 || g.deadline>e.deliveryDeadline) revert ContextMismatch();
        if(!SignatureChecker.isValidSignatureNow(e.buyer,H.signingHash("IntentPass.Grant",block.chainid,address(this),H.grantHash(g)),ownerSignature)) revert InvalidSignature();
        if(q.schemaVersion!=1 || q.serviceHash!=keccak256("dataset-report") || q.seller!=e.seller || q.payee!=e.payee
            || q.asset!=address(asset) || q.amount!=e.price || q.serviceTermsHash!=e.serviceTermsHash) revert ContextMismatch();
        if(!SignatureChecker.isValidSignatureNow(e.seller,H.signingHash("IntentPass.Quote",block.chainid,address(this),H.quoteHash(q)),quoteSignature)) revert InvalidSignature();
        _gate(e.buyer,address(this),g.amount,context);
        consumed[e.buyer][g.nonce]=true;
        orders[e.orderId]=Order(context,e.buyer,e.seller,e.payee,e.price,e.bond,e.deliveryDeadline,e.settlementDeadline,
            e.datasetHash,e.serviceTermsHash,bytes32(0),0,State.FUNDED);
        locked+=g.amount;
        uint256 beforeBalance=asset.balanceOf(address(this));
        uint256 buyerBefore=asset.balanceOf(e.buyer);
        asset.safeTransferFrom(e.buyer,address(this),g.amount);
        if(asset.balanceOf(address(this))-beforeBalance!=g.amount || buyerBefore-asset.balanceOf(e.buyer)!=g.amount) revert TransferAmountMismatch();
        emit Funded(e.orderId,context,e.buyer,g.amount);
    }
    function _checkEnvelope(IntentHash.Envelope calldata e) private view {
        if(e.schemaVersion!=1 || e.chainId!=block.chainid || e.arbiter!=address(this) || e.orderId==bytes32(0)
            || e.buyer==address(0) || e.seller==address(0) || e.payee==address(0)
            || e.buyer==address(this) || e.seller==address(this) || e.payee==address(this) || e.asset!=address(asset) || e.price==0
            || e.reviewer!=reviewer || e.committeeHash!=committeeHash || e.threshold!=2 || e.deliverySchemaHash!=DELIVERY_SCHEMA
            || e.allocationPolicyHash!=ALLOCATION_POLICY || e.intentReleasePolicyHash!=RELEASE_POLICY || e.pactPaymentPublicKeyHash!=bytes32(0)) revert ContextMismatch();
        if(e.deliveryDeadline<=block.timestamp || e.settlementDeadline<=e.deliveryDeadline) revert Expired();
    }
    function deliver(Delivery calldata d) external nonReentrant {
        Order storage o=orders[d.orderId];
        if(o.state!=State.FUNDED) revert InvalidState();
        if(block.timestamp>o.deliveryDeadline) revert Expired();
        if(msg.sender!=o.seller || d.schemaVersion!=1 || d.datasetHash!=o.datasetHash || d.serviceTermsHash!=o.serviceTermsHash || d.reportHash==bytes32(0)) revert InvalidDelivery();
        o.evidenceHash=keccak256(abi.encode(DELIVERY_SCHEMA,d)); o.state=State.EVIDENCE_FROZEN;
        emit EvidenceFrozen(d.orderId,o.evidenceHash);
    }
    function voteDigest(bytes32 id, bytes32 evidence, uint256 expiresAt) public view returns(bytes32) {
        return H.signingHash("IntentPass.Acceptance",block.chainid,address(this),
            keccak256(abi.encode(VOTE_TYPE,id,orders[id].contextHash,evidence,committeeHash,expiresAt)));
    }
    function accept(bytes32 id, bytes32 evidence, uint256 expiresAt, uint256 memberIndex, bytes calldata signature) external nonReentrant {
        Order storage o=orders[id];
        if(o.state!=State.EVIDENCE_FROZEN) revert InvalidState();
        if(block.timestamp>o.settlementDeadline || expiresAt<block.timestamp || expiresAt>o.settlementDeadline) revert Expired();
        if(memberIndex>=3 || evidence!=o.evidenceHash || evidence==bytes32(0)) revert InvalidVote();
        uint8 bit=uint8(1<<memberIndex);
        if(o.voteMask & bit!=0) revert InvalidVote();
        if(!SignatureChecker.isValidSignatureNow(committee[memberIndex],voteDigest(id,evidence,expiresAt),signature)) revert InvalidSignature();
        o.voteMask |= bit; emit Accepted(id,memberIndex,evidence);
        if(o.voteMask==3 || o.voteMask==5 || o.voteMask==6) {o.state=State.CERTIFIED;emit Certified(id);}
    }
    function settle(bytes32 id) external nonReentrant {
        Order storage o=orders[id];
        if(o.state!=State.CERTIFIED) revert InvalidState();
        if(block.timestamp>o.settlementDeadline) revert Expired();
        _allocate(id,o,State.ALLOCATED_PAID,o.bond,o.price);
    }
    function timeout(bytes32 id) external nonReentrant {
        Order storage o=orders[id];
        if(block.timestamp<=o.settlementDeadline) revert Expired();
        if(o.state==State.FUNDED || o.state==State.EVIDENCE_FROZEN) _allocate(id,o,State.ALLOCATED_REFUND,o.price+o.bond,0);
        else if(o.state==State.CERTIFIED) _allocate(id,o,State.ALLOCATED_COMPENSATION,o.price,o.bond);
        else revert InvalidState();
    }
    function _allocate(bytes32 id,Order storage o,State next,uint256 buyerAmount,uint256 payeeAmount) private {
        if(buyerAmount!=0) _gate(address(this),o.buyer,buyerAmount,o.contextHash);
        if(payeeAmount!=0) _gate(address(this),o.payee,payeeAmount,o.contextHash);
        o.state=next; uint256 total=o.price+o.bond;locked-=total;outstanding+=total;
        credits[id][o.buyer]+=buyerAmount;credits[id][o.payee]+=payeeAmount;
        emit Allocated(id,next,buyerAmount,payeeAmount);
    }
    function withdraw(bytes32 id) external nonReentrant {
        uint256 amount=credits[id][msg.sender];if(amount==0) revert NoCredit();
        _gate(address(this),msg.sender,amount,orders[id].contextHash);
        uint256 beforeBalance=asset.balanceOf(address(this));uint256 recipientBefore=asset.balanceOf(msg.sender);
        credits[id][msg.sender]=0;outstanding-=amount;withdrawn[id][msg.sender]+=amount;
        asset.safeTransfer(msg.sender,amount);
        if(beforeBalance-asset.balanceOf(address(this))!=amount || asset.balanceOf(msg.sender)-recipientBefore!=amount) revert TransferAmountMismatch();
        emit Withdrawn(id,msg.sender,amount);
    }
    function _gate(address from,address to,uint256 amount,bytes32 context) private view {
        if(!eligibility.canTransfer(address(asset),from,to,amount,context)) revert IdentityBlocked();
    }
}
