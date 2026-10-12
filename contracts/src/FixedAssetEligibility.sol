// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAssetEligibility} from "./IAssetEligibility.sol";

/// @notice Fixed-asset transfer constraints for the IntentPass demo asset profile.
/// @dev This gate does not verify identity, registration, balances, allowances, or context.
/// The escrow independently checks authorization and the token enforces ERC20 transfers.
contract FixedAssetEligibility is IAssetEligibility {
    error InvalidAsset();

    address public immutable asset;

    constructor(address fixedAsset) {
        if (fixedAsset.code.length == 0) revert InvalidAsset();
        asset = fixedAsset;
    }

    function canTransfer(address candidateAsset, address from, address to, uint256 amount, bytes32)
        external view override returns (bool)
    {
        return candidateAsset == asset && from != address(0) && to != address(0) && amount > 0;
    }
}
