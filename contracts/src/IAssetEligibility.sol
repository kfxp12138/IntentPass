// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice IntentPass adapter interface, NOT a purported Cleanverse ABI.
/// Production implementation must bridge the actual official CVI/CVA rules.
interface IAssetEligibility {
    function canTransfer(address asset, address from, address to, uint256 amount, bytes32 contextHash)
        external view returns (bool);
}
