//SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.6.8;

interface IAuctionModified {
    function createBid(bytes32 auctionId, uint256 amount) external payable;
}

contract ETHReceiver {
    uint256 counter = 0;

    // Allows the contract to place a bid.
    function relayBid(
        address auction,
        bytes32 auctionId,
        uint256 amount
    ) external payable {
        IAuctionModified(auction).createBid{value: amount}(auctionId, amount);
    }

    receive() external payable {
        // Receives some ETH, but also does some calculation to
        // make gas less predictable than a simple send.
        for (uint256 i = 0; i < 3; i++) {
            counter += 2;
        }
    }
}
